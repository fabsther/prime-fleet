use serde::Serialize;
use serde_json::Value;

const LIMIT: usize = 1024 * 1024;

#[derive(Clone, Debug, Serialize)]
pub struct SseEvent {
    pub id: Option<u64>,
    pub event: Option<String>,
    pub data: Value,
}

#[derive(Default)]
pub struct Parser {
    line: Vec<u8>,
    data: String,
    id: Option<u64>,
    event: Option<String>,
    after_cr: bool,
    started: bool,
}

impl Parser {
    // Parse bytes, not network chunks: chunks can split UTF-8, CRLF and fields.
    pub fn feed(&mut self, bytes: &[u8]) -> Result<Vec<SseEvent>, String> {
        let mut events = Vec::new();
        for &byte in bytes {
            if self.after_cr && byte == b'\n' {
                self.after_cr = false;
                continue;
            }
            self.after_cr = false;
            if byte == b'\r' || byte == b'\n' {
                self.after_cr = byte == b'\r';
                if let Some(event) = self.finish_line()? {
                    events.push(event);
                }
            } else {
                self.line.push(byte);
                if self.line.len() + self.data.len() > LIMIT {
                    return Err("SSE frame too large".into());
                }
            }
        }
        Ok(events)
    }

    fn finish_line(&mut self) -> Result<Option<SseEvent>, String> {
        let bytes = std::mem::take(&mut self.line);
        let mut line = std::str::from_utf8(&bytes).map_err(|_| "Invalid SSE UTF-8")?;
        if !self.started {
            self.started = true;
            line = line.trim_start_matches('\u{feff}');
        }
        if line.is_empty() {
            if self.data.is_empty() {
                self.event = None;
                return Ok(None);
            }
            let data = std::mem::take(&mut self.data);
            let data = serde_json::from_str(data.trim_end_matches('\n'))
                .map_err(|_| "Invalid SSE JSON")?;
            return Ok(Some(SseEvent {
                id: self.id,
                event: self.event.take(),
                data,
            }));
        }
        if line.starts_with(':') {
            return Ok(None);
        }
        let (field, value) = line.split_once(':').unwrap_or((line, ""));
        let value = value.strip_prefix(' ').unwrap_or(value);
        match field {
            "data" => {
                self.data.push_str(value);
                self.data.push('\n');
            }
            "event" => self.event = Some(value.to_owned()),
            "id" if !value.contains('\0') => {
                self.id = if value.is_empty() {
                    None
                } else {
                    Some(value.parse().map_err(|_| "Invalid Studio SSE cursor")?)
                };
            }
            _ => {}
        }
        if self.data.len() > LIMIT {
            return Err("SSE frame too large".into());
        }
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn split_utf8_crlf_comments_and_resume_marker() {
        let wire = "\u{feff}: heartbeat\r\nid: 17\r\nevent: message\r\ndata: {\"kind\":\"message\",\n data: ignored\ndata: \"text\":\"été\"}\r\n\r\nid: 18\ndata: {\"kind\":\"replay_truncated\",\"seq\":18}\n\n";
        let mut parser = Parser::default();
        let mut events = Vec::new();
        for byte in wire.as_bytes() {
            events.extend(parser.feed(&[*byte]).unwrap());
        }
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].id, Some(17));
        assert_eq!(events[0].event.as_deref(), Some("message"));
        assert_eq!(events[0].data["text"], "été");
        assert_eq!(events[1].data["kind"], "replay_truncated");
        assert_eq!(events[1].event, None);
    }
    #[test]
    fn no_dispatch_until_blank_line_and_id_persists() {
        let mut parser = Parser::default();
        assert!(parser
            .feed(b"id: 42\ndata: {\"seq\":42}\n")
            .unwrap()
            .is_empty());
        assert_eq!(parser.feed(b"\n").unwrap()[0].id, Some(42));
        assert_eq!(parser.feed(b"data: {}\r\r").unwrap()[0].id, Some(42));
        assert!(parser.feed(b": heartbeat\n\n").unwrap().is_empty());
    }
    #[test]
    fn invalid_or_unbounded_data_is_rejected() {
        assert!(Parser::default().feed(b"data: not-json\n\n").is_err());
        assert!(Parser::default().feed(b"id: nope\n").is_err());
        assert!(Parser::default().feed(&vec![b'x'; LIMIT + 1]).is_err());
        assert!(Parser::default().feed(b"data: \xff\n").is_err());
    }
}

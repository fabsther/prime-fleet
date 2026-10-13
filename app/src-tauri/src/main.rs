// Console subsystem is intentional: desktop CLI has real stdout on Windows,
// including release builds and redirected subprocess output.
fn main() {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let args: Vec<String> = std::env::args().skip(1).collect();
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    if !args.is_empty() {
        std::process::exit(prime_fleet_lib::cli(args));
    }
    prime_fleet_lib::run();
}

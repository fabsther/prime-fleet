package dev.primefleet.secrets

import app.tauri.plugin.Invoke
import com.fasterxml.jackson.databind.ObjectMapper
import org.junit.Assert.*
import org.junit.Test
import javax.crypto.KeyGenerator

class SecretsPluginTest {
    @Test fun bridgeInputAndGcmPreserveEveryTokenByte() {
        val mapper = ObjectMapper()
        val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        for (token in listOf("synthetic-token_123+/=\"\\", "x".repeat(8192))) {
            val payload = mapper.writeValueAsString(mapOf("id" to "synthetic-machine-id", "token" to token))
            val invoke = Invoke(1, "set", 2, 3, { _, _ -> }, payload, mapper)
            val args = invoke.parseArgs(SecretArgs::class.java)
            assertEquals("synthetic-machine-id", args.id)
            assertArrayEquals(token.toByteArray(Charsets.UTF_8), args.token!!.toByteArray(Charsets.UTF_8))
            val encrypted = SecretCipher.encrypt(args.id, args.token!!, key)
            assertEquals(token.toByteArray(Charsets.UTF_8).size + 28, encrypted.size)
            val recovered = SecretCipher.decrypt(args.id, encrypted, key)
            assertArrayEquals(token.toByteArray(Charsets.UTF_8), recovered.toByteArray(Charsets.UTF_8))
            // The same payload under the wrong machine ID must fail GCM authentication.
            assertThrows(Exception::class.java) { SecretCipher.decrypt("wrong-machine-id", encrypted, key) }
            encrypted[encrypted.lastIndex] = (encrypted.last().toInt() xor 1).toByte()
            assertThrows(Exception::class.java) { SecretCipher.decrypt(args.id, encrypted, key) }
        }
        val read = Invoke(1, "get", 2, 3, { _, _ -> }, "{\"id\":\"synthetic-machine-id\",\"token\":null}", mapper)
        assertNull(read.parseArgs(SecretArgs::class.java).token)
    }
}

package dev.primefleet.secrets

import android.app.Activity
import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@InvokeArg
class SecretArgs { lateinit var id: String; var token: String? = null }

// Shared by the Keystore plugin and local byte-preservation/AAD regression tests.
internal object SecretCipher {
    fun encrypt(id: String, token: String, key: SecretKey): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key)
        cipher.updateAAD(id.toByteArray(Charsets.UTF_8))
        val ciphertext = cipher.doFinal(token.toByteArray(Charsets.UTF_8))
        // Android GCM stores a 12-byte nonce followed by ciphertext and the 16-byte tag.
        check(cipher.iv.size == 12)
        return cipher.iv + ciphertext
    }
    fun decrypt(id: String, data: ByteArray, key: SecretKey): String {
        require(data.size >= 28)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, data.copyOfRange(0, 12)))
        cipher.updateAAD(id.toByteArray(Charsets.UTF_8))
        return String(cipher.doFinal(data.copyOfRange(12, data.size)), Charsets.UTF_8)
    }
}

@TauriPlugin
class SecretsPlugin(private val activity: Activity) : Plugin(activity) {
    // SharedPreferences contains only AES-GCM ciphertext. The key is non-exportable.
    private val prefs by lazy { activity.getSharedPreferences("fleet-secrets", Context.MODE_PRIVATE) }
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val alias = "dev.primefleet.app.tokens"
        if (store.containsAlias(alias)) return store.getKey(alias, null) as SecretKey
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true).build())
        }.generateKey()
    }
    @Command fun set(invoke: Invoke) = guarded(invoke) {
        val args = invoke.parseArgs(SecretArgs::class.java)
        val data = SecretCipher.encrypt(args.id, requireNotNull(args.token), key())
        check(prefs.edit().putString(args.id, Base64.encodeToString(data, Base64.NO_WRAP)).commit())
        invoke.resolve()
    }
    @Command fun get(invoke: Invoke) = guarded(invoke) {
        val args = invoke.parseArgs(SecretArgs::class.java)
        val data = Base64.decode(requireNotNull(prefs.getString(args.id, null)), Base64.NO_WRAP)
        val token = SecretCipher.decrypt(args.id, data, key())
        invoke.resolve(JSObject().put("token", token))
    }
    @Command fun remove(invoke: Invoke) = guarded(invoke) {
        val args = invoke.parseArgs(SecretArgs::class.java)
        check(prefs.edit().remove(args.id).commit())
        invoke.resolve()
    }
    private fun guarded(invoke: Invoke, action: () -> Unit) {
        try { synchronized(this) { action() } }
        catch (_: Exception) { invoke.reject("Secure Android storage failed") }
    }
}

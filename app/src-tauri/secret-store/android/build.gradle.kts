plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}
android {
    namespace = "dev.primefleet.secrets"
    compileSdk = 36
    defaultConfig { minSdk = 24 }
}
dependencies { implementation(project(":tauri-android")) }

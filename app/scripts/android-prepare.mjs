// Run after `tauri android init`; use only the SDK already installed by the user.
import { readFileSync, writeFileSync } from 'node:fs';
const root = new URL('../src-tauri/gen/android/', import.meta.url);
const app = new URL('app/build.gradle.kts', root);
let text = readFileSync(app, 'utf8');
text = text.replace(/compileSdk = \d+(?:\s*\n\s*compileSdkMinor = \d+)?/, 'compileSdk = 36\n    compileSdkMinor = 1').replace(/targetSdk = \d+/, 'targetSdk = 36');
// The app remains debuggable; retain full native symbols in Cargo target, not the installable APK.
text = text.replace('isJniDebuggable = true', 'isJniDebuggable = false').replace(/^\s*jniLibs\.keepDebugSymbols\.add\(.*\)\r?\n/gm, '');
writeFileSync(app, text);
const props = new URL('gradle.properties', root);
let settings = readFileSync(props, 'utf8');
if (!settings.includes('android.builder.sdkDownload=false')) settings += '\nandroid.builder.sdkDownload=false\n';
// Kotlin incremental paths cannot span a C: Cargo cache and a D: project.
if (!settings.includes('kotlin.incremental=false')) settings += 'kotlin.incremental=false\n';
writeFileSync(props, settings);
console.log('Android uses installed API 36.1. Automatic SDK downloads are disabled.');

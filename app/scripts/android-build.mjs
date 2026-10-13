// Keep normal Tauri builds. On Windows without symlink rights, package the same built library by copy.
import './android-prepare.mjs';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const app = fileURLToPath(new URL('../', import.meta.url));
async function run(command, args) {
  let output = '';
  const windows = process.platform === 'win32';
  // These are fixed build commands, never user or token input. Windows cmd needs backslash executable paths.
  const child = windows && !command.toLowerCase().endsWith('.exe')
    ? spawn(`${command.replaceAll('/', '\\')} ${args.join(' ')}`, { cwd: app, shell: true, stdio: ['inherit', 'pipe', 'pipe'] })
    : spawn(command, args, { cwd: app, stdio: ['inherit', 'pipe', 'pipe'] });
  for (const [source, target] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) source.on('data', data => { target.write(data); output = (output + data).slice(-100000); });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  return {code, output};
}
const result = await run('npm', ['run', 'tauri', '--', 'android', 'build', '--debug', '--target', 'aarch64']);
if (!result.code) process.exit(0);
if (process.platform !== 'win32' || !result.output.includes('Creation symbolic link is not allowed')) process.exit(result.code || 1);
console.log('Windows symlink rights are unavailable. Copying the freshly built ARM64 library; no system setting changes.');
const jni = new URL('../src-tauri/gen/android/app/src/main/jniLibs/arm64-v8a/', import.meta.url);
mkdirSync(jni, {recursive:true});
copyFileSync(new URL('../src-tauri/target/aarch64-linux-android/debug/libprime_fleet_lib.so', import.meta.url), new URL('libprime_fleet_lib.so', jni));
const stripTool = join(process.env.NDK_HOME, 'toolchains/llvm/prebuilt/windows-x86_64/bin/llvm-strip.exe');
const strip = await run(stripTool, ['--strip-debug', fileURLToPath(new URL('libprime_fleet_lib.so', jni))]);
if (strip.code) process.exit(strip.code);
const gradle = await run('src-tauri/gen/android/gradlew.bat', ['-p', 'src-tauri/gen/android', ':app:assembleArm64Debug', '-x', ':app:rustBuildArm64Debug', '-PabiList=arm64-v8a', '-ParchList=arm64', '-PtargetList=aarch64']);
process.exit(gradle.code || 0);

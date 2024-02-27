# Vivid Extension
Visual Studio Code extension for [Vivid programming language](https://github.com/lehtojo/vivid-2).

## Building

Using this extension requires the first version of [Vivid](https://github.com/lehtojo/vivid) to be in your PATH environment variable.

### Prebuilt extension
1. Go to the [releases tab](https://github.com/lehtojo/vivid-extension/releases) and download the latest release
2. Open Visual Studio Code and select View > Extensions > "..." (upper right corner) > Install from VSIX

### Building for source
```bash
git clone https://github.com/lehtojo/vivid-extension
cd vivid-extension/
npm install
npx vsce package
```
After successful build, there should be a '.vsix' file. Open Visual Studio Code and select View > Extensions > "..." (upper right corner) > Install from VSIX.
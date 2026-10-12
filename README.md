# Hasher

Hasher turns files and folders into password-protected ZIP archives you can
share as text, then restore whenever you need them. Encryption and conversion
happen in your browser; files are never uploaded to a server.

## Run locally

Requirements: Node.js 22.12 or newer and npm 11 or newer.

```sh
npm install
npm start
```

Open the local URL printed by Angular CLI. Create a production build with
`npm run build`.

## Use Hasher

1. Choose files or a folder. For large projects, skip dependency and environment folders.
2. Enter a strong password and create the encrypted text.
3. Copy and share the text separately from the password.
4. To restore, paste the text, enter the same password, and download the ZIP.

The archive uses AES-256 encryption. Keep your password safe: Hasher cannot
recover it. Base64 text is about one-third larger than the encrypted binary
archive, so this format is best for small-to-medium transfers.

## Privacy

File selection, encryption, and recovery run locally in the browser. Hasher
does not upload files or passwords. Anyone with both the encrypted text and
password can open the archive, so share them through separate channels.

## GitHub Pages deployment

Every push to `master` builds and deploys Hasher to
[https://abhayvishnoi.github.io/hasher/](https://abhayvishnoi.github.io/hasher/).
The workflow can also be run manually from the repository's Actions tab.

## Technology

- Angular 22 with strict TypeScript
- Tailwind CSS 4 and DaisyUI 5
- [`@zip.js/zip.js`](https://github.com/gildas-lormeau/zip.js) for encrypted ZIP archives

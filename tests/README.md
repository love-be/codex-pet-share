# Browser upload regression checks

Run `npm run dev`, then open
`http://127.0.0.1:5173/tests/upload-assets.html` in Safari (and other browsers
when checking cross-browser behavior). The page runs automatically and reports
failures in the page; `document.body.dataset.result` is `passed` or `failed`
when complete.

Run `npx tsc -p tests/tsconfig.json --pretty false` to type-check the browser
checks and their imported production modules.

The checks use only repository fixtures and production asset generators and
adapter validators. They do not submit uploads or require an account. They
cover both atlas versions, concurrent encoder initialization, output signatures,
MIME types, decoded dimensions, upload size limits, lossless RGBA preservation,
rejection of mislabeled PNG and invalid dimensions, and the actual React file
input and drop handlers with empty MIME types and wrong-type files. The handler
checks dispatch browser events; they complement native file picker and Finder
drag/drop verification. Safari's native canvas
encoding result is diagnostic output, so the checks remain useful if Safari adds
WebP encoding support.

For the complete upload interaction, also use a throwaway local backend and
verify `#/upload` through the native file picker and drag/drop with valid,
corrupt, and wrong-type files. Confirm the resulting detail and gallery previews
render and the package, GIF, and playground use the uploaded spritesheet.

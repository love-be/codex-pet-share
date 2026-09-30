import { generatePosterImage, generatePreviewImage, generateShareImage } from "../src/uploads/upload-assets/previewImages";
import { encodeCanvasAsLosslessWebp } from "../src/uploads/upload-assets/webpEncode";
import { readSpritesheetVersion, readUploadManifest, validateManifestSpriteVersion } from "../src/uploads/upload-assets/manifest";
import { validatePosterImage, validatePreviewImage, validateShareImage, validateSpritesheet } from "../adapters/cloudflare-worker/src/api/validation";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { FileField } from "../src/uploads/FileField";

const output = document.querySelector<HTMLPreElement>("#results")!;
const results: string[] = [];
let failed = 0;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function check(name: string, run: () => Promise<void>) {
  try {
    await run();
    results.push(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    results.push(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
  output.textContent = results.join("\n");
}

async function bytes(file: Blob) {
  return new Uint8Array(await file.arrayBuffer());
}

async function fixture(version: 1 | 2, name: string, type: string) {
  const response = await fetch(`/test-assets/pets/debug-duck-v${version}/${name}`);
  assert(response.ok, `Could not load ${name} v${version}`);
  return new File([await response.blob()], name, { type });
}

async function decode(file: Blob) {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function rejects(run: () => unknown, message: RegExp) {
  try {
    run();
  } catch (error) {
    assert(error instanceof Error && message.test(error.message), `Unexpected rejection: ${String(error)}`);
    return;
  }
  throw new Error("Invalid asset was accepted");
}

async function main() {
  const canvas = document.createElement("canvas");
  canvas.width = 192;
  canvas.height = 208;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#ff0000";
  context.fillRect(0, 0, 96, 104);
  const native = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.78));
  results.push(`Browser: ${navigator.userAgent}`, `Native canvas WebP request returned: ${native?.type}`);

  for (const version of [1, 2] as const) {
    await check(`v${version} generated assets are genuine, decodable WebP accepted by the adapter`, async () => {
      const sheet = await fixture(version, "spritesheet.webp", "");
      const manifest = await readUploadManifest(await fixture(version, "pet.json", "application/json"));
      const detected = await readSpritesheetVersion(sheet);
      assert(detected === version, "Wrong atlas version");
      validateManifestSpriteVersion(manifest, detected);
      validateSpritesheet(await bytes(sheet), version);
      // The upload workflow generates these concurrently, sharing one encoder initialization.
      const [share, preview, poster] = await Promise.all([
        generateShareImage(manifest, sheet), generatePreviewImage(sheet, version), generatePosterImage(sheet)
      ]);
      validateShareImage(await bytes(share));
      validatePreviewImage(await bytes(preview), version);
      validatePosterImage(await bytes(poster));
      for (const file of [preview, poster]) {
        assert(file.type === "image/webp", `Wrong MIME type for ${file.name}`);
        const data = await bytes(file);
        assert(String.fromCharCode(...data.slice(0, 4)) === "RIFF" && String.fromCharCode(...data.slice(8, 12)) === "WEBP", `${file.name} contains non-WebP bytes`);
        const image = await decode(file);
        assert(image.naturalWidth === (file === poster ? 192 : version === 2 ? 7008 : 5472), "Wrong output width");
        assert(image.naturalHeight === (file === poster ? 208 : 104), "Wrong output height");
      }
      assert(preview.size <= 1024 * 1024 && poster.size <= 512 * 1024, "Generated assets exceed upload limits");
      results.push(`v${version} preview=${preview.size} bytes, poster=${poster.size} bytes`);
    });
  }

  await check("lossless encoder preserves RGBA pixels", async () => {
    const image = await decode(await encodeCanvasAsLosslessWebp(canvas, "spritesheet.webp"));
    const decoded = document.createElement("canvas");
    decoded.width = canvas.width;
    decoded.height = canvas.height;
    const decodedContext = decoded.getContext("2d")!;
    decodedContext.drawImage(image, 0, 0);
    const expected = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const actual = decodedContext.getImageData(0, 0, canvas.width, canvas.height).data;
    assert(expected.every((value, index) => value === actual[index]), "Lossless pixels changed");
  });

  await check("adapter rejects PNG bytes mislabeled as WebP and invalid dimensions", async () => {
    const png = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), "image/png"));
    const mislabeled = new File([png], "preview.webp", { type: "image/webp" });
    const data = await bytes(mislabeled);
    rejects(() => validatePreviewImage(data), /preview.*WebP/);
    rejects(() => validatePosterImage(data), /poster.*WebP/);
    rejects(() => validateSpritesheet(data), /spritesheet.*WebP/);
    const wrongSize = await bytes(await encodeCanvasAsLosslessWebp(canvas, "preview.webp"));
    rejects(() => validatePreviewImage(wrongSize), /5472x104/);
    rejects(() => validateSpritesheet(wrongSize), /1536x1872/);
    rejects(() => validatePosterImage(new Uint8Array()), /WebP/);
  });

  await check("file input and drop handlers accept valid files with empty MIME types and reject wrong types", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      for (const name of ["pet.json", "spritesheet.webp"] as const) {
        let selected: File | null = null;
        let error = "";
        flushSync(() => root.render(createElement(FileField, {
          accept: name === "pet.json" ? ".json" : ".webp", file: null,
          help: name, icon: "upload", label: name,
          onFile: (file) => { selected = file; }, onInvalidFile: (message) => { error = message; }
        })));
        const input = host.querySelector("input")!;
        const label = host.querySelector("label")!;
        const valid = await fixture(2, name, "");
        const invalid = new File(["wrong type"], "wrong.txt", { type: "text/plain" });
        for (const mode of ["input", "drop"] as const) {
          for (const file of [valid, invalid]) {
            selected = null;
            error = "";
            const transfer = new DataTransfer();
            transfer.items.add(file);
            if (mode === "input") {
              input.files = transfer.files;
              input.dispatchEvent(new Event("change", { bubbles: true }));
            } else {
              label.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
            }
            assert(file === valid ? selected !== null && !error : selected === null && error === `Drop ${name}.`, `${mode} handled ${file.name} incorrectly`);
          }
        }
      }
    } finally {
      root.unmount();
      host.remove();
    }
  });

  document.body.dataset.result = failed ? "failed" : "passed";
  results.push(`${results.filter((line) => line.startsWith("PASS")).length} passed, ${failed} failed`);
  output.textContent = results.join("\n");
}

void main().catch((error) => {
  document.body.dataset.result = "failed";
  output.textContent += `\nFAIL ${String(error)}`;
});

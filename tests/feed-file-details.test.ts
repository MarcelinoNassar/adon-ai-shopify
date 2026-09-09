import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const panelSource = readFileSync(
  new URL("../app/components/FeedsPanel.tsx", import.meta.url),
  "utf8",
);

test("successful XML links show their generated variant count and file size", () => {
  assert.match(panelSource, /import \{ GoPackage \} from "react-icons\/go"/);
  assert.match(
    panelSource,
    /import \{ TbFileTypeXml \} from "react-icons\/tb"/,
  );
  assert.match(
    panelSource,
    /<GoPackage aria-hidden="true" \/>[\s\S]*feed\.generatedItems[\s\S]*variants/,
  );
  assert.match(
    panelSource,
    /<TbFileTypeXml aria-hidden="true" \/>[\s\S]*formatFileSize\(feed\.fileSizeBytes\)/,
  );
  assert.equal(panelSource.match(/<FeedFileDetails feed=/g)?.length, 2);
});

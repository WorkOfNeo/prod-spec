import { test } from "node:test";
import assert from "node:assert/strict";
import type { ProdSpecOutput } from "@/lib/prod-spec/config";
import { outputConfigKey } from "./output-config-key";

// Minimal output — the fields the fingerprint reads, at their neutral values.
function output(patch: Partial<ProdSpecOutput> = {}): ProdSpecOutput {
  return {
    variantKey: "layout:abc",
    widthMm: 40,
    heightMm: 60,
    enabled: true,
    ...patch,
  };
}

test("outputConfigKey — a dimension edit changes the fingerprint", () => {
  assert.notEqual(outputConfigKey(output({ widthMm: 40 })), outputConfigKey(output({ widthMm: 45 })));
  assert.notEqual(outputConfigKey(output({ heightMm: 60 })), outputConfigKey(output({ heightMm: 61 })));
});

test("outputConfigKey — a pin edit changes the fingerprint", () => {
  const before = output({ fieldOverrides: { customerName: "Netto A/S" } });
  const after = output({ fieldOverrides: { customerName: "Netto GmbH" } });
  assert.notEqual(outputConfigKey(before), outputConfigKey(after));

  // Adding a pin is a change too.
  assert.notEqual(outputConfigKey(output()), outputConfigKey(before));
});

test("outputConfigKey — pin key ORDER does not change the fingerprint", () => {
  const a = output({ fieldOverrides: { customerName: "Netto", articleNo: "123" } });
  const b = output({ fieldOverrides: { articleNo: "123", customerName: "Netto" } });
  assert.equal(outputConfigKey(a), outputConfigKey(b));
});

test("outputConfigKey — carton barcode type + height are part of the fingerprint", () => {
  assert.notEqual(outputConfigKey(output()), outputConfigKey(output({ cartonBarcodeType: "ean13" })));
  assert.notEqual(
    outputConfigKey(output({ cartonBarcodeHeightMm: 16 })),
    outputConfigKey(output({ cartonBarcodeHeightMm: 20 })),
  );
});

test("outputConfigKey — info-area size pick is part of the fingerprint", () => {
  assert.notEqual(outputConfigKey(output()), outputConfigKey(output({ infoAreaSizeId: "size_1" })));
});

test("outputConfigKey — toggling `enabled` or changing variantKey does NOT change it", () => {
  // enabled is excluded (toggling off just drops the output); the key is always
  // compared within the same variant, so variantKey is out of scope too.
  assert.equal(outputConfigKey(output({ enabled: true })), outputConfigKey(output({ enabled: false })));
  assert.equal(
    outputConfigKey(output({ variantKey: "layout:abc" })),
    outputConfigKey(output({ variantKey: "layout:xyz" })),
  );
});

test("outputConfigKey — an absent carton height and an explicit undefined agree", () => {
  const a = output();
  const b = output({ cartonBarcodeHeightMm: undefined });
  assert.equal(outputConfigKey(a), outputConfigKey(b));
});

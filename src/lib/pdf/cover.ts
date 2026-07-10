import { renderCoverPageHtml, type CoverPageInput } from "./bundle-pages";
import { inlineProdSpecImages } from "./inline-images";
import { renderPdf } from "./renderer";

// The cover document as a PDF buffer — the shared render step behind both
// places a style's cover is produced: the runner (baked into every bundle at
// generation) and publish (re-rendered so the delivered copy reflects the
// approval state at the moment the supplier receives it). Keeping it in one
// place means both paths inline general-info images and page-break identically.
//
// General-info images ride inside the cover document as data URLs — page
// setContent() can't fetch a bare /api path — so we inline them whenever the
// cover carries general info and we know which ProdSpec owns the images.
export async function renderStyleCoverPdf(
  input: CoverPageInput,
  prodSpecIdForImages: string | null,
): Promise<Buffer> {
  let html = renderCoverPageHtml(input);
  if (prodSpecIdForImages && input.generalInfo?.markdown?.trim()) {
    html = await inlineProdSpecImages(html, prodSpecIdForImages);
  }
  return renderPdf({ html });
}

// Output Builder auto-fit — see fit-block.ts for the algorithm.
export {
  autoFitBlock,
  bodyCapPt,
  DEFAULT_AUTO_FIT_OPTIONS,
  largestFitting,
  type AutoFitInput,
  type AutoFitOptions,
  type AutoFitResult,
  type AutoFitSample,
  type FitBudget,
  type FitCandidate,
  type MovedCandidate,
} from "./fit-block";
export { compactAround, type CompactOptions, type CompactResult } from "./compact";
export * from "./geometry";
export { measurePage, MEASURE_PAGE_JS, type BlockMeasure, type HtmlEvaluator, type PageMeasure } from "./measure";

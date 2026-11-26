// Setup file for a run with SCRIBE_LOW_PAGE_BUDGET set.
import { opt } from '../../js/containers/app.js';

opt.pageBudget = 1;
// When layoutChunkPages is null, pageRuns sizes layout chunks to opt.pageBudget, which would split multi-page documents into single-page layout passes.
opt.dev.layoutChunkPages = Infinity;

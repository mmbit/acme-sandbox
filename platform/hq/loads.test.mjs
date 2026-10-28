// node --test platform/hq/loads.test.mjs: HQ's page through the coordinator, in each look (the coordinator's
// hqloads.test.ts), run for a change to HQ's own files too, as the push tests run an area's own tests
import '../coordinator/src/hqloads.test.ts';

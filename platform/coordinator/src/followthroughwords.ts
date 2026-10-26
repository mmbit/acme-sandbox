// org.yaml's followThrough (template/company/org.yaml documents it): prompt, the words after the hourly check's own, and
// delivered, what it and a woken pause's owner judge by, else the platform's
import { yamlFile } from './company.ts';

const followThrough = (key: string) => String(yamlFile('company/org.yaml').followThrough?.[key] ?? '').trim();
export const followThroughWords = () => followThrough('prompt');
export const deliveredWords = () =>
  followThrough('delivered') ||
  'what the board asked for is in its hands: the thing itself, or the results and report it waits for. A job ending, merging or deploying with nothing to show is not delivery.';

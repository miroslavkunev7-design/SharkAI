import assert from 'node:assert/strict';
import { researchTopic } from '../lib/research-sources';
import { citedFindings } from '../lib/research-synthesis';

assert.equal(researchTopic('Deep research: Marine heatwaves'), 'Marine heatwaves');
assert.equal(researchTopic('Търси в интернет: софийското метро'), 'софийското метро');
assert.equal(researchTopic('Моля, направи задълбочено проучване на климата'), 'климата');
assert.equal(researchTopic('Research methods'), 'Research methods');

const sources = [
  { id: 'E1', sourceId: 1, title: 'Reference entry', excerpt: 'Excess ocean temperatures can stress sensitive coastal ecosystems.' },
  { id: 'E5', sourceId: 5, title: 'Study abstract', excerpt: 'Coral surveys found bleaching near the coast after sustained warming.' },
];
const finding = {
  text: 'The overview describes coastal ecosystem stress while the study documents bleaching after sustained warming.',
  firstEvidenceId: 'E1', secondEvidenceId: 'E5',
};
assert.deepEqual(citedFindings({ findings: [finding] }, sources), [{ text: finding.text, sourceIds: [1, 5] }]);
assert.deepEqual(citedFindings({ findings: [{ ...finding, secondEvidenceId: 'E4' }] }, sources), []);
assert.deepEqual(citedFindings({ findings: [{ ...finding, secondEvidenceId: 'E1' }] }, sources), []);
assert.deepEqual(citedFindings({ findings: [{ ...finding, quote: 'the same threshold in all oceans' }] }, sources), []);
assert.deepEqual(citedFindings({ findings: [{ ...finding, text: `${finding.text} https://example.test` }] }, sources), []);
assert.deepEqual(citedFindings({ findings: [finding] }, [sources[0], { ...sources[1], excerpt: '' }]), []);
console.log('Research comparisons require two distinct IDs bound to stored source excerpts.');

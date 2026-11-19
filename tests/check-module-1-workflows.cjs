const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const directory = path.join(__dirname, '..', 'n8n', 'workflows');
const filenames = [
  'W01-channel-webhook.json',
  'W02-channel-email.json',
  'W03-channel-whatsapp.json',
  'W10-ai-core.json',
  'W11-tool-router.json',
  'W12-human-approval.json',
  'W13-automation-builder.json',
  'W14-memory-and-context.json',
  'W19-error-monitoring.json',
];
const readWorkflow = (filename) => JSON.parse(fs.readFileSync(path.join(directory, filename), 'utf8'));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

async function runSingleCodeNode(filename, input) {
  const workflow = readWorkflow(filename);
  const [node, ...extra] = workflow.nodes.filter(({ type }) => type === 'n8n-nodes-base.code');
  assert.ok(node);
  assert.equal(extra.length, 0);
  assert.equal(node.parameters.mode, 'runOnceForEachItem');
  const result = await new AsyncFunction('$json', node.parameters.jsCode)(input);
  return result.json;
}

for (const filename of filenames) {
  test(`${filename} is inactive and its node connections resolve`, () => {
    const workflow = readWorkflow(filename);
    assert.equal(workflow.active, false);
    assert.ok(!workflow.pinData || Object.keys(workflow.pinData).length === 0);
    const nodesByName = new Map(workflow.nodes.map((node) => [node.name, node]));
    assert.equal(nodesByName.size, workflow.nodes.length);
    assert.equal(new Set(workflow.nodes.map((node) => node.id)).size, workflow.nodes.length);
    assert.ok(workflow.nodes.some((node) => node.type === 'n8n-nodes-base.stickyNote'));

    for (const node of workflow.nodes) {
      assert.ok(!node.credentials || Object.keys(node.credentials).length === 0, node.name);
      assert.equal(node.position.length, 2);
      assert.ok(node.position.every(Number.isFinite), node.name);
      if (typeof node.parameters.jsCode === 'string') {
        assert.doesNotThrow(() => new AsyncFunction(node.parameters.jsCode), node.name);
      }
    }

    for (const [source, connectionTypes] of Object.entries(workflow.connections)) {
      assert.ok(nodesByName.has(source), source);
      for (const [type, outputs] of Object.entries(connectionTypes)) {
        for (const edges of outputs) {
          for (const edge of edges ?? []) {
            assert.ok(nodesByName.has(edge.node), `${source} → ${edge.node}`);
            assert.equal(edge.type, type);
            assert.ok(Number.isInteger(edge.index));
          }
        }
      }
    }
  });
}

test('AI Core routes model and tooling subnodes to the same agent', () => {
  const core = readWorkflow('W10-ai-core.json');
  const agents = core.nodes.filter((node) => node.type === '@n8n/n8n-nodes-langchain.agent');
  assert.equal(agents.length, 1);
  const incomingPorts = new Set();
  for (const byType of Object.values(core.connections)) {
    for (const [type, outputs] of Object.entries(byType)) {
      if (outputs.flat().some((edge) => edge?.node === agents[0].name)) incomingPorts.add(type);
    }
  }
  assert.ok(incomingPorts.has('main'));
  assert.ok(incomingPorts.has('ai_languageModel'));
  assert.ok(incomingPorts.has('ai_tool'));
});

test('W12 creates review metadata without granting execution', async () => {
  const result = await runSingleCodeNode('W12-human-approval.json', {
    request_id: 'test_request_12',
    tool_id: 'test_message',
    risk: 'write_with_approval',
    operation: 'preview',
    secret: 'synthetic-secret-w12',
  });
  assert.equal(result.status, 'review_required');
  assert.equal(result.approval_task, 'unconfigured');
  assert.equal(result.execution_allowed, false);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-secret-w12/);
});

test('W12 blocks a supplied approval and redirects finance to the separate module', async () => {
  const payload = {
    request_id: 'test_request_12',
    tool_id: 'test_message',
    risk: 'write_with_approval',
    operation: 'approve',
    approved: true,
  };
  const approval = await runSingleCodeNode('W12-human-approval.json', payload);
  const finance = await runSingleCodeNode('W12-human-approval.json', {
    ...payload, risk: 'restricted_finance',
  });
  assert.equal(approval.error.code, 'APPROVAL_BACKEND_UNCONFIGURED');
  assert.equal(finance.error.code, 'FINANCE_MODULE_REQUIRED');
  assert.equal(approval.execution_allowed, false);
  assert.equal(finance.execution_allowed, false);
});

test('W14 ignores supplied history and returns no context across users', async () => {
  for (const operation of ['read', 'append', 'delete']) {
    const response = await runSingleCodeNode('W14-memory-and-context.json', {
      user_id: 'test_user_a',
      conversation_id: 'test_conversation_b',
      request_id: 'test_request_14',
      operation,
      context: ['synthetic-secret-w14'],
    });
    assert.equal(response.status, 'unavailable');
    assert.equal(response.error.code, 'CONTEXT_STORAGE_UNCONFIGURED');
    assert.deepEqual(response.context, []);
    assert.doesNotMatch(JSON.stringify(response), /synthetic-secret-w14|test_user_a|test_conversation_b/);
  }
});

test('W19 drops raw details for both node and trigger failures', async () => {
  const noise = 'synthetic-secret-w19';
  const normal = await runSingleCodeNode('W19-error-monitoring.json', {
    request_id: 'test_request_19',
    workflow: { id: 'exampleWorkflow1', name: noise },
    execution: { id: '42', retryOf: '37', url: noise, error: { message: noise, stack: noise } },
    headers: { authorization: noise },
  });
  assert.equal(normal.code, 'EXECUTION_FAILURE');
  assert.equal(normal.execution_id, '42');
  assert.equal(normal.retry_of, '37');
  assert.equal(normal.request_id, 'test_request_19');
  assert.equal(normal.replay, 'manual_review_required');
  assert.equal(normal.alert_delivery, 'unconfigured');
  assert.doesNotMatch(JSON.stringify(normal), /synthetic-secret-w19/);

  const trigger = await runSingleCodeNode('W19-error-monitoring.json', {
    trigger: { error: { message: noise, cause: { stack: noise } } },
    workflow: { id: 'exampleWorkflow2' },
  });
  assert.equal(trigger.code, 'TRIGGER_FAILURE');
  assert.equal(trigger.execution_id, undefined);
  assert.doesNotMatch(JSON.stringify(trigger), /synthetic-secret-w19/);
});


function createCodeNodeRunner(filename, name) {
  const { nodes } = readWorkflow(filename);
  const node = nodes.find((candidate) => candidate.name === name);
  assert.equal(node?.parameters.mode, 'runOnceForAllItems');
  const run = new AsyncFunction('$input', '$', node.parameters.jsCode);
  return async function execute(input, upstream = {}) {
    const [item, ...extra] = await run(
      { all: () => [{ json: input }] },
      (source) => ({ first: () => ({ json: upstream[source] }) }),
    );
    assert.equal(extra.length, 0);
    return item.json;
  };
}

const draftArguments = {
  title: 'Обобщаване на инвентар',
  objective: 'Покажи чернова на седмично обобщение за преглед.',
  channel: 'email',
  action: 'general_automation',
};
const createToolInput = (tool, scopes) => ({
  request_context: JSON.stringify({
    user_id: 'test_user_a',
    conversation_id: 'test_conversation_a',
    channel: 'email',
    request_id: 'test_request_11',
    permission_context: { scopes },
  }),
  tool_id: tool,
  arguments_json: JSON.stringify(draftArguments),
});

test('W11 denies unregistered tools and draft calls without a backend scope', async () => {
  const route = createCodeNodeRunner('W11-tool-router.json', 'Приложи правила и валидирай');
  const forbidden = await route(createToolInput('transfer_funds', ['automation:draft']));
  const noScope = await route(createToolInput('draft_automation', []));
  assert.equal(forbidden.error.code, 'TOOL_NOT_ALLOWED');
  assert.equal(noScope.error.code, 'SCOPE_REQUIRED');
});

test('W11 and W13 return a verified draft for a new automation', async () => {
  const route = createCodeNodeRunner('W11-tool-router.json', 'Приложи правила и валидирай');
  const build = createCodeNodeRunner('W13-automation-builder.json', 'Подготви проект за автоматизация');
  const finish = createCodeNodeRunner('W11-tool-router.json', 'Върни проверен резултат');
  const packet = await route(createToolInput('draft_automation', ['automation:draft']));
  const draft = await build(packet);
  const result = await finish(draft, { 'Приложи правила и валидирай': packet });
  assert.equal(result.status, 'ok');
  assert.equal(result.data.mode, 'draft');
  assert.equal(result.data.action, 'general_automation');
  assert.equal(result.data.objective, draftArguments.objective);
  assert.equal(result.data.steps.length, 4);
  assert.equal(result.data.acceptance_checks.length, 3);
});

test('W13 refuses an expired draft packet', async () => {
  const build = createCodeNodeRunner('W13-automation-builder.json', 'Подготви проект за автоматизация');
  const result = await build({
    route: 'builder',
    draft_input: draftArguments,
    deadline: Date.now() - 1,
  });
  assert.equal(result.error.code, 'INVALID_DRAFT_REQUEST');
});

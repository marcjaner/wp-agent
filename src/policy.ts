import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { AsyncLocalStorage } from 'node:async_hooks';

export type Environment = 'disposable' | 'staging' | 'production';
export type Decision = 'allow' | 'allow_with_snapshot' | 'require_approval' | 'deny';
export type Risk = 'read' | 'low' | 'medium' | 'high' | 'critical';
export type Origin = 'session' | 'preexisting';
export type Reversibility = 'reversible' | 'partial' | 'irreversible';
export type Resource = { type: string; id?: number | string; status?: string; origin?: Origin; title?: string };
export type ProposedAction = {
  id?: string;
  tool: string;
  category: 'content' | 'media' | 'site_config' | 'plugin' | 'theme' | 'browser' | 'raw';
  mutation: boolean;
  target?: Resource;
  source?: Resource;
  intent?: { changes?: string[]; status?: string; count?: number; sourceId?: number };
  reversible: Reversibility;
  input?: Record<string, unknown>;
};
export type PolicyAssessment = { staticRisk: Risk; decision: Decision; reason: string; semantic?: SemanticResult | null };
export type SemanticResult = { classification: 'consistent' | 'uncertain' | 'suspicious'; intentMismatch: boolean; confidence: number; reason: string };
export type JournalResource = { origin: Origin; initialStatus?: string; status?: string; createdBy?: string; modifiedBy?: string };
export type JournalAction = {
  id: string; timestamp: string; tool: string; target?: Resource; source?: Resource; input?: Record<string, unknown>;
  policy: PolicyAssessment; result: { success: boolean; created?: Resource; snapshot?: string; error?: string };
};
export type Session = {
  sessionId: string; goal?: string; environment: { type: Environment; site: string };
  startedAt: string; resources: Record<string, JournalResource>; actions: JournalAction[];
};

const rank: Record<Decision, number> = { allow: 0, allow_with_snapshot: 1, require_approval: 2, deny: 3 };
const secretKey = /password|secret|token|api.?key|authorization|cookie|credential|private.?key/i;
const secretValue = /(Bearer\s+\S+|Basic\s+[A-Za-z0-9+/=]+|(?:sk|ts)_[A-Za-z0-9_-]{12,})/gi;
const executionScope = new AsyncLocalStorage<boolean>();
export function insidePolicyExecution(): boolean { return executionScope.getStore() === true; }

export function redact(value: unknown, key = ''): unknown {
  if (secretKey.test(key)) return '[REDACTED]';
  if (typeof value === 'string') {
    let clean = value.replace(secretValue, '[REDACTED]');
    for (const name of ['WP_PASSWORD', 'WP_APP_PASSWORD', 'TYPESAFE_API_KEY', 'WP_SSH_KEY_PATH']) {
      const secret = process.env[name];
      if (secret && secret.length >= 4) clean = clean.replaceAll(secret, '[REDACTED]');
    }
    return clean;
  }
  if (Array.isArray(value)) return value.map(item => redact(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name)]));
  return value;
}

export function resourceKey(resource: Resource): string | null {
  return resource.id === undefined ? null : `${resource.type}:${resource.id}`;
}

export function sessionFile(): string { return path.resolve(process.env.WP_AGENT_SESSION_FILE || '.wp-agent/session.json'); }

export function savePolicySnapshot(name: string, value: unknown): string {
  const directory = path.resolve('.wp-agent/snapshots');
  fs.mkdirSync(directory, { recursive: true });
  const filename = path.join(directory, `${name}-${Date.now()}-${randomUUID().slice(0, 8)}.json`);
  fs.writeFileSync(filename, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  return filename;
}

export function readSession(file = sessionFile()): Session | null {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Session;
}

export function writeSession(session: Session, file = sessionFile()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(redact(session), null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, file);
}

export function startSession(goal: string | undefined, environment: Environment, site: string, file = sessionFile()): Session {
  const current = readSession(file);
  if (current?.environment.site && current.environment.site !== site) throw new Error('Existing session belongs to another site. Finish or move its journal before starting a new site session.');
  if (current) {
    const archive = path.join(path.dirname(file), 'sessions', `${current.sessionId}.json`);
    writeSession(current, archive);
  }
  const session: Session = { sessionId: randomUUID(), goal, environment: { type: environment, site }, startedAt: new Date().toISOString(), resources: {}, actions: [] };
  writeSession(session, file);
  return session;
}

function sessionFor(site: string, file: string): Session {
  const existing = readSession(file);
  if (existing) {
    if (!existing.environment.site) throw new Error('Legacy session has no site. Start a new session to archive it.');
    if (existing.environment.site !== site) throw new Error(`Session site ${existing.environment.site} differs from ${site}. Start a matching session.`);
    return existing;
  }
  return startSession(undefined, 'production', site, file);
}

export function evaluateStatic(action: ProposedAction, session: Session): PolicyAssessment {
  if (!action.mutation) return { staticRisk: 'read', decision: 'allow', reason: 'Read-only operation.' };
  const env = session.environment.type;
  const key = action.target && resourceKey(action.target);
  const tracked = key ? session.resources[key] : undefined;
  const origin = tracked?.origin || action.target?.origin || 'preexisting';
  const status = action.target?.status || tracked?.status || tracked?.initialStatus;
  const count = action.intent?.count || 1;
  const tool = action.tool;
  const publishing = ['publish', 'future'].includes(action.intent?.status || '') || action.intent?.changes?.includes('publish');
  const deleting = ['pages.delete', 'pages.bulk-delete', 'media.delete', 'plugin.remove', 'theme.remove'].includes(tool) || action.intent?.status === 'trash';
  if (action.category === 'raw' || (action.category === 'browser' && action.mutation))
    return { staticRisk: 'high', decision: 'require_approval', reason: 'Unstructured mutation needs explicit approval.' };
  if (deleting && count > 1) return { staticRisk: 'critical', decision: 'require_approval', reason: `Bulk deletion affects ${count} resources.` };
  if (action.reversible === 'irreversible') return { staticRisk: 'critical', decision: 'require_approval', reason: 'The operation cannot be reliably reversed.' };
  if (action.category === 'theme' || action.category === 'plugin') {
    if (env === 'production') return { staticRisk: tool === 'theme.activate' ? 'critical' : 'high', decision: 'require_approval', reason: 'Plugin or theme lifecycle changes affect the whole production site.' };
    if (env === 'staging' && (tool.endsWith('.activate') || deleting)) return { staticRisk: 'high', decision: 'require_approval', reason: 'Activation or removal changes the staging site.' };
    return { staticRisk: 'medium', decision: 'allow_with_snapshot', reason: 'Plugin or theme state should be recorded before the change.' };
  }
  if (action.category === 'site_config') {
    if (env === 'production') return { staticRisk: 'high', decision: 'require_approval', reason: 'Site-wide configuration on production requires approval.' };
    return { staticRisk: env === 'staging' ? 'high' : 'medium', decision: 'allow_with_snapshot', reason: 'Site-wide configuration needs a previous-state snapshot.' };
  }
  if (deleting) {
    if (origin === 'preexisting' || status === 'publish') return { staticRisk: 'critical', decision: 'require_approval', reason: 'Deletion affects preexisting or published content.' };
    return { staticRisk: 'medium', decision: 'allow_with_snapshot', reason: 'Trash a session-created draft with a snapshot.' };
  }
  if (publishing) return { staticRisk: 'high', decision: 'require_approval', reason: 'Publishing changes public content and needs explicit approval.' };
  if (action.category === 'media' && tool === 'media.upload') return { staticRisk: 'low', decision: 'allow', reason: 'Uploading a new media item is scoped to a new resource.' };
  if (tool === 'pages.create' || tool === 'pages.clone') return { staticRisk: 'low', decision: 'allow', reason: 'Creates a new draft page.' };
  if (origin === 'session' && status === 'draft') return { staticRisk: 'low', decision: 'allow', reason: 'Edits a draft created during this session.' };
  if (status === 'publish') {
    if (env === 'production') return { staticRisk: 'high', decision: 'require_approval', reason: 'Edits preexisting published production content.' };
    return { staticRisk: 'high', decision: 'allow_with_snapshot', reason: 'Published content needs a snapshot before editing.' };
  }
  return { staticRisk: env === 'production' ? 'medium' : 'low', decision: 'allow_with_snapshot', reason: 'Preexisting content needs a snapshot before editing.' };
}

export function shouldClassify(action: ProposedAction, session: Session): boolean {
  if (!action.mutation || !session.goal) return false;
  if (action.tool === 'pages.clone' || (action.tool === 'pages.create' && action.intent?.status !== 'publish') || action.tool === 'media.upload') return false;
  const key = action.target && resourceKey(action.target);
  const origin = (key && session.resources[key]?.origin) || action.target?.origin || 'preexisting';
  if (origin === 'session' && action.target?.status === 'draft' && !action.intent?.status && action.category === 'content') return false;
  return origin === 'preexisting' || action.target?.status === 'publish' || ['site_config', 'plugin', 'theme', 'raw', 'browser'].includes(action.category) || !!action.intent?.count && action.intent.count > 1 || action.intent?.status === 'publish';
}

export interface SemanticProvider { classify(action: ProposedAction, session: Session): Promise<SemanticResult>; }

function validSemanticResult(value: unknown): value is SemanticResult {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<SemanticResult>;
  return ['consistent', 'uncertain', 'suspicious'].includes(item.classification || '')
    && typeof item.intentMismatch === 'boolean'
    && typeof item.confidence === 'number' && Number.isFinite(item.confidence) && item.confidence >= 0 && item.confidence <= 1
    && typeof item.reason === 'string' && item.reason.length > 0;
}

export class JevPolicyProvider implements SemanticProvider {
  async classify(action: ProposedAction, session: Session): Promise<SemanticResult> {
    const { choice, noul, TypeSafeClient } = await import('@typesafe-ai/sdk');
    const client = new TypeSafeClient({ timeout: 5000, retry: { maxRetries: 0 }, logLevel: 'off' });
    const state = {
      goal: session.goal || '',
      environment: session.environment.type,
      recentActions: session.actions.slice(-8).map(item => ({ tool: item.tool, target: item.target || null, source: item.source || null, success: item.result.success, created: item.result.created || null })),
      proposedAction: { tool: action.tool, category: action.category, target: action.target || null, source: action.source || null, intent: action.intent || null },
    };
    const response = await client.systemOne({ state: JSON.parse(JSON.stringify(redact(state))), questions: {
      fit: choice('Does the proposed WordPress action fit the stated goal and recent workflow? Judge intent, not whether the action is generally allowed.', {
        consistent: 'The action is a sensible step toward the goal.',
        uncertain: 'There is not enough context to tell.',
        suspicious: 'The action conflicts with or is unrelated to the goal.',
      }),
      mismatch: noul('Does the proposed action conflict with the stated user goal?'),
    } });
    const fit = response.answers.fit;
    if (!['consistent', 'uncertain', 'suspicious'].includes(fit.choice) || !Number.isFinite(fit.confidence) || fit.confidence < 0 || fit.confidence > 1 || !Number.isFinite(response.answers.mismatch.noul) || response.answers.mismatch.noul < 0 || response.answers.mismatch.noul > 1) throw new Error('Invalid Jev classification.');
    const classification = fit.choice as SemanticResult['classification'];
    return { classification, intentMismatch: response.answers.mismatch.noul >= 0.75, confidence: fit.confidence, reason: classification === 'suspicious' ? 'Jev judged the action inconsistent with the session goal.' : classification === 'uncertain' ? 'Jev could not establish that the action fits the goal.' : 'Jev judged the action consistent with the session goal.' };
  }
}

export async function evaluatePolicy(action: ProposedAction, session: Session, provider?: SemanticProvider | null): Promise<PolicyAssessment> {
  const result = evaluateStatic(action, session);
  if (!shouldClassify(action, session) || !provider) return result;
  try {
    const semantic = await provider.classify(action, session);
    if (!validSemanticResult(semantic)) throw new Error('Invalid semantic provider result.');
    result.semantic = semantic;
    if (semantic.classification === 'suspicious' || semantic.intentMismatch || semantic.classification === 'uncertain' || semantic.confidence < 0.65) {
      result.decision = rank[result.decision] < rank.require_approval ? 'require_approval' : result.decision;
      result.reason += ` ${semantic.reason}`;
    }
  } catch {
    result.semantic = { classification: 'uncertain', intentMismatch: false, confidence: 0, reason: 'Semantic provider was unavailable or returned invalid output.' };
    if (rank[result.decision] < rank.require_approval) result.decision = 'require_approval';
    result.reason += ' Semantic evaluation failed; approval is required.';
  }
  return result;
}

export class PolicyDecisionError extends Error {
  code = 'policy_decision';
  constructor(public action: ProposedAction, public assessment: PolicyAssessment) { super(assessment.reason); }
}

export function recordRead(tool: string, target: Resource | undefined, site: string, input?: Record<string, unknown>, file = sessionFile()): void {
  const session = sessionFor(site, file);
  const id = randomUUID();
  const key = target && resourceKey(target);
  if (key && !session.resources[key]) session.resources[key] = { origin: 'preexisting', initialStatus: target?.status, status: target?.status };
  session.actions.push({ id, timestamp: new Date().toISOString(), tool, target, input: redact(input || {}) as Record<string, unknown>, policy: { staticRisk: 'read', decision: 'allow', reason: 'Read-only operation.' }, result: { success: true } });
  writeSession(session, file);
}

export type ExecutionOptions<T> = {
  site: string; file?: string; provider?: SemanticProvider | null; interactive?: boolean;
  snapshot?: () => Promise<string> | string;
  created?: (result: T) => Resource | undefined;
};

export async function executeMutation<T>(proposal: ProposedAction, perform: () => Promise<T>, options: ExecutionOptions<T>): Promise<T> {
  const file = options.file || sessionFile();
  const session = sessionFor(options.site, file);
  const action = { ...proposal, id: proposal.id || randomUUID() };
  const targetKey = action.target && resourceKey(action.target);
  if (targetKey && !session.resources[targetKey]) session.resources[targetKey] = { origin: action.target?.origin || 'preexisting', initialStatus: action.target?.status, status: action.target?.status };
  const sourceKey = action.source && resourceKey(action.source);
  if (sourceKey && !session.resources[sourceKey]) session.resources[sourceKey] = { origin: action.source?.origin || 'preexisting', initialStatus: action.source?.status, status: action.source?.status };
  const provider = options.provider === undefined && process.env.TYPESAFE_API_KEY ? new JevPolicyProvider() : options.provider;
  const assessment = await evaluatePolicy(action, session, provider);
  const record: JournalAction = { id: action.id, timestamp: new Date().toISOString(), tool: action.tool, target: action.target, source: action.source, input: redact(action.input || {}) as Record<string, unknown>, policy: assessment, result: { success: false } };
  if (assessment.decision === 'require_approval' && options.interactive && process.stdin.isTTY) {
    const prompt = createInterface({ input: process.stdin, output: process.stderr });
    const answer = await prompt.question(`${action.tool} ${action.target?.type || ''} ${action.target?.id || ''} ${action.target?.title || ''}\nEnvironment: ${session.environment.type}; risk: ${assessment.staticRisk}\n${assessment.reason}\nType approve to continue: `).finally(() => prompt.close());
    if (answer.trim() === 'approve') record.policy = { ...assessment, reason: `${assessment.reason} Approved interactively.` };
    else { record.result.error = 'Approval denied.'; session.actions.push(record); writeSession(session, file); throw new PolicyDecisionError(action, assessment); }
  } else if (assessment.decision === 'require_approval' || assessment.decision === 'deny') {
    record.result.error = 'Approval required or action denied.';
    session.actions.push(record); writeSession(session, file); throw new PolicyDecisionError(action, assessment);
  }
  try {
    if (assessment.decision === 'allow_with_snapshot' && !options.snapshot) throw new Error('Policy requires a snapshot but this operation has no snapshot provider.');
    if (options.snapshot) record.result.snapshot = await options.snapshot();
    const result = await executionScope.run(true, perform);
    const created = options.created?.(result);
    if (created) {
      record.result.created = created;
      const key = resourceKey(created);
      if (key) session.resources[key] = { origin: 'session', createdBy: action.id, status: created.status, initialStatus: created.status };
    }
    if (targetKey) { session.resources[targetKey].modifiedBy = action.id; if (action.intent?.status) session.resources[targetKey].status = action.intent.status; }
    record.result.success = true;
    session.actions.push(record); writeSession(session, file);
    return result;
  } catch (error) {
    record.result.error = error instanceof Error ? error.message : String(error);
    session.actions.push(record); writeSession(session, file);
    if (record.result.snapshot && error instanceof Error) (error as Error & { snapshot?: string }).snapshot = record.result.snapshot;
    throw error;
  }
}

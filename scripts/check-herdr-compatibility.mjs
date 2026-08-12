import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = path => readFileSync(resolve(root, path), 'utf8');

export function auditFixture(value) {
  const errors = [];
  const visit = (current, key = '') => {
    if (Array.isArray(current)) return current.forEach(item => visit(item, key));
    if (current && typeof current === 'object') {
      for (const [childKey, child] of Object.entries(current)) {
        if (/(token|secret|password|credential|socket|hostname|host|user(name)?|path)/i.test(childKey)) {
          errors.push(`forbidden private-material key: ${childKey}`);
        }
        visit(child, childKey);
      }
      return;
    }
    if (typeof current !== 'string') return;
    if (/(^|[\\/])(Users|home|private|tmp)[\\/]|[A-Z]:\\|@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|BEGIN [A-Z ]*PRIVATE KEY|\b(?:\d{1,3}\.){3}\d{1,3}\b/i.test(current)) {
      errors.push(`private-looking value at ${key}`);
    }
    if (/(?:_id$|^pane_id$|^agent$|^display_agent$|^name$|^title$|^label$|^value$)/i.test(key)
      && current !== '' && !/(fictional|example)/i.test(current)) {
      errors.push(`non-fictional identifier at ${key}`);
    }
  };
  visit(value);
  return errors;
}

export function auditAdapterFixtureMappings(entries, adapter) {
  return entries
    .filter(entry => !adapter.includes(entry.fixture.replace(/^server\//, '../')))
    .map(entry => `${entry.fixture}: adapter mapping case missing`);
}

export function auditWorkflow(workflow) {
  const errors = [];
  const permissionDeclarations = workflow.match(/^\s*permissions\s*:/gm) ?? [];
  const lines = workflow.split('\n');
  const permissionsStart = lines.findIndex(line => line === 'permissions:');
  const permissionScopes = [];
  if (permissionsStart >= 0) {
    for (const line of lines.slice(permissionsStart + 1)) {
      if (line !== '' && !/^\s/.test(line)) break;
      permissionScopes.push(line);
    }
  }
  if (permissionScopes.filter(line => line.trim() !== '').join('\n') !== '  contents: read') {
    errors.push('compatibility workflow permissions are not exactly contents: read');
  }
  if (permissionDeclarations.length > 1) {
    errors.push('compatibility workflow has additional permission declarations');
  }
  if (/^\s*pull_request_target\s*:/m.test(workflow)) {
    errors.push('compatibility workflow uses pull_request_target');
  }
  if (/secrets\.|\brelease\b|\bpublish\b|git push|git tag/i.test(workflow)) {
    errors.push('compatibility workflow is publishing or uses secrets');
  }
  return errors;
}

function tableFor(entries) {
  const rows = entries.map(entry => `| \`${entry.release}\` | \`${entry.protocol}\` |`).join('\n');
  return `| Herdr release | Snapshot protocol |\n|---|---|\n${rows}`;
}

function checkUpstream(entry, directory, errors) {
  const cargoPath = resolve(directory, 'Cargo.toml');
  const wirePath = resolve(directory, 'src/protocol/wire.rs');
  const sessionPath = resolve(directory, 'src/api/schema/session.rs');
  if (!existsSync(cargoPath) || !existsSync(wirePath) || !existsSync(sessionPath)) {
    errors.push(`${entry.release}: upstream checkout lacks Cargo.toml, src/protocol/wire.rs, or src/api/schema/session.rs`);
    return;
  }
  const cargo = readFileSync(cargoPath, 'utf8');
  const packageSection = cargo.match(/\[package\]([\s\S]*?)(?:\n\[|$)/)?.[1] ?? '';
  const version = packageSection.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  const wire = readFileSync(wirePath, 'utf8');
  const session = readFileSync(sessionPath, 'utf8');
  const snapshot = session.match(/pub struct SessionSnapshot\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
  const protocol = Number(wire.match(/PROTOCOL_VERSION\s*:\s*u\d+\s*=\s*(\d+)/)?.[1]);
  if (version !== entry.release) errors.push(`${entry.release}: Cargo version is ${version ?? 'missing'}`);
  if (protocol !== entry.protocol) errors.push(`${entry.release}: protocol is ${Number.isNaN(protocol) ? 'missing' : protocol}`);
  for (const field of ['version', 'protocol', 'workspaces', 'tabs', 'panes', 'layouts', 'agents']) {
    if (!new RegExp(`\\b${field}\\s*:`).test(snapshot)) errors.push(`${entry.release}: SessionSnapshot field ${field} missing`);
  }
}

export function checkCompatibility(args = []) {
  const errors = [];
  const manifest = JSON.parse(read('compatibility/herdr.json'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.supported) || manifest.supported.length === 0) {
    errors.push('invalid compatibility manifest schema');
    return errors;
  }
  const releases = new Set();
  const protocols = new Set();
  for (const entry of manifest.supported) {
    if (releases.has(entry.release)) errors.push(`duplicate release ${entry.release}`);
    if (protocols.has(entry.protocol)) errors.push(`duplicate protocol ${entry.protocol}`);
    releases.add(entry.release);
    protocols.add(entry.protocol);
    if (!/^[0-9a-f]{40}$/.test(entry.upstreamCommit)) errors.push(`${entry.release}: invalid immutable commit`);
    if (!existsSync(resolve(root, entry.fixture))) {
      errors.push(`${entry.release}: missing fixture ${entry.fixture}`);
      continue;
    }
    const fixture = JSON.parse(read(entry.fixture));
    if (fixture.version !== entry.release) errors.push(`${entry.fixture}: version drift`);
    if (fixture.protocol !== entry.protocol) errors.push(`${entry.fixture}: protocol drift`);
    errors.push(...auditFixture(fixture).map(error => `${entry.fixture}: ${error}`));
  }
  const expectedTable = tableFor(manifest.supported);
  for (const path of ['README.md', 'docs/operations.md']) {
    const document = read(path);
    const actual = document.match(/<!-- herdr-compatibility:start -->[\s\S]*?\n([\s\S]*?)\n<!-- herdr-compatibility:end -->/)?.[1];
    if (actual !== expectedTable) errors.push(`${path}: compatibility table drift`);
  }
  const adapter = read('server/src/adapter.rs');
  if (!adapter.includes('../../compatibility/herdr.json')) errors.push('adapter does not consume the compatibility manifest');
  if (/HERDR_PROTOCOLS/.test(adapter)) errors.push('adapter duplicates supported protocols');
  errors.push(...auditAdapterFixtureMappings(manifest.supported, adapter));
  const workflow = read('.github/workflows/herdr-compatibility-drift.yml');
  for (const entry of manifest.supported) {
    if (!workflow.includes(`ref: ${entry.upstreamCommit}`)) errors.push(`${entry.release}: workflow commit drift`);
  }
  errors.push(...auditWorkflow(workflow));

  const upstreamArgs = args.filter(arg => arg.startsWith('--upstream=')).map(arg => arg.slice(11));
  for (const entry of manifest.supported) {
    const match = upstreamArgs.find(value => value.startsWith(`${entry.release}=`));
    if (upstreamArgs.length && !match) errors.push(`${entry.release}: upstream checkout argument missing`);
    if (match) checkUpstream(entry, match.slice(entry.release.length + 1), errors);
  }
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = checkCompatibility(process.argv.slice(2));
  if (errors.length) {
    console.error(errors.map(error => `ERROR: ${error}`).join('\n'));
    process.exitCode = 1;
  } else {
    console.log('Herdr compatibility contract is consistent and fixture privacy checks passed.');
  }
}

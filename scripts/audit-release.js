#!/usr/bin/env node
'use strict';

// Audit Git's staged snapshot and reachable/reflog history, not unstaged files.
// Findings report rule/location only; suspected secret values are never printed.
const {execFileSync} = require('node:child_process');
const path = require('node:path');
const {TextDecoder} = require('node:util');

const cwd = path.resolve(__dirname, '..');
const findings = [];
const inspected = new Set();
// Optional local-only terms are supplied by the release operator. Never put
// personal defaults, encoded names, or private provenance in this public file.
const privateTerms = (process.env.RELEASE_AUDIT_PRIVATE_TERMS || '').split(/[,;\r\n]+/).map(term => term.trim()).filter(Boolean);
const privatePatterns = privateTerms.map(term => new RegExp('(^|[^\\p{L}\\p{N}_])' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^\\p{L}\\p{N}_])', 'iu'));
const textExtensions = new Set(['.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx', '.json', '.md', '.txt', '.html', '.css', '.cmd', '.ps1', '.yml', '.yaml']);
const forbiddenExtension = /\.(?:mp4|mkv|webm|mov|avi|m4v|mp3|m4a|wav|ogg|ogv|flac|aac|opus|png|jpe?g|gif|webp|avif|svg|ico|bmp|exe|dll|zip|7z|tar|gz|pyc|sqlite3?|db|log|bak|part|download|pdf|docx?|xlsx?|pptx?)$/i;
const forbiddenDirectory = /(?:^|\/)(?:node_modules|vendor|dist|out|build|downloads?|captures?|screenshots?|media|browser[-_]?profiles?|(?:[a-z0-9_.-]*[-_])?profiles?|user data|indexeddb|local storage|cache|gpucache|logs?|\.data|\.tmp|\.cache|\.npm|\.electron|\.venv|__pycache__|\.git)(?:\/|$)/i;
const forbiddenPrivateFile = /(?:^|\/)(?:\.env(?:\..*)?|credentials?(?:\..*)?|cookies?(?:\..*)?|tokens?(?:\..*)?|queue\.json|job[-_]?logs?(?:\..*)?|local-settings\.json|config\.local\..*)$/i;

function git(args, encoding = 'utf8') {
  return execFileSync('git', args, {cwd, encoding, windowsHide: true, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']});
}
function flag(scope, file, rule, line) {
  const finding = {scope, file, rule};
  if (line !== undefined) finding.line = line;
  findings.push(finding);
}
function fixtureUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'example.com' || host.endsWith('.example.com') || host === 'example.org' || host.endsWith('.example.org');
  } catch {return false;}
}

function inspectText(scope, file, text, {commitIdentity = false} = {}) {
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index], number = index + 1;
    if (privatePatterns.some(pattern => pattern.test(line)) && !(commitIdentity && /^[^<>\s@]+@users\.noreply\.github\.com$/.test(line))) flag(scope, file, 'private local term', number);
    if (/\b[EF]:[\\/]/i.test(line)) flag(scope, file, 'original source drive path', number);
    if (/\b[A-Z]:[\\/](?![\\/]*Windows(?:[\\/]|['"`\s]|$))/i.test(line)) flag(scope, file, 'absolute non-system Windows path', number);
    if (/(?:^|[\s'"`:(/])\/(?:Users|home|mnt|media|run\/user|private\/var)\/[a-z0-9_.-]/i.test(line)) flag(scope, file, 'absolute private Unix path', number);
    if (/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/.test(line)) flag(scope, file, 'private key material', number);
    if (/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/.test(line) || /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/.test(line) || /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/.test(line)) flag(scope, file, 'credential token pattern', number);
    if (/\b(?:authorization|bearer)\s*[:=]?\s*['"]?(?:Bearer\s+)?[A-Za-z0-9_.-]{24,}/i.test(line)) flag(scope, file, 'authorization credential', number);

    // Protective option names and obvious placeholders are harmless; nontrivial
    // secret assignments are blocked without printing their contents.
    const assignments = line.matchAll(/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|secret[_-]?key)\b\s*[:=]\s*['"]([^'"\s]{8,})['"]/gi);
    for (const match of assignments) {
      if (!/^(?:example|placeholder|replace[_-]?me|your[_-]|dummy|fixture|test[_-]|password)/i.test(match[1])) flag(scope, file, 'non-placeholder secret assignment', number);
    }
    const emailText = line.replace(/https?:\/\/[^\s<>'"`\])]+/gi, url => fixtureUrl(url) ? '' : url);
    const emails = emailText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
    for (const email of emails) {
      if (!(commitIdentity && /^[^<>\s@]+@users\.noreply\.github\.com$/i.test(email))) flag(scope, file, 'email address', number);
    }
    const urls = line.match(/https?:\/\/[^\s<>'"`\])]+/gi) || [];
    for (const raw of urls) {
      if (fixtureUrl(raw)) continue;
      try {
        const url = new URL(raw);
        if (url.username || url.password) flag(scope, file, 'URL login credentials', number);
        if (/(?:^|\.)instagram\.com$/i.test(url.hostname) && /^\/(?:p|reels?|tv|stories)\//i.test(url.pathname)) flag(scope, file, 'Instagram media reference', number);
        if ([...url.searchParams.keys()].some(key => /^(?:igsh|igshid|img_index|fbclid|signature|sig|token|access_token|api_key|auth|authorization|credential|password)$/i.test(key))) flag(scope, file, 'sensitive or reference URL query', number);
      } catch {/* Documentation may contain incomplete URL syntax. */}
    }
  }
}

function inspectBlob(scope, entry) {
  const {file, mode, hash} = entry;
  const normalized = file.replace(/\\/g, '/');
  if (privatePatterns.some(pattern => pattern.test(normalized))) flag(scope, file, 'private local term in filename');
  if (forbiddenExtension.test(normalized) || forbiddenDirectory.test(normalized) || forbiddenPrivateFile.test(normalized)) {
    flag(scope, file, 'excluded media, binary, private, cache, or runtime file');
    return; // Do not read potentially credential-bearing files or binary assets.
  }
  if (mode !== '100644' && mode !== '100755') {flag(scope, file, 'symlink or non-source Git entry'); return;}
  const basename = path.posix.basename(normalized);
  if (!textExtensions.has(path.posix.extname(normalized).toLowerCase()) && !['LICENSE', 'NOTICE', '.gitignore', '.gitattributes', '.editorconfig'].includes(basename)) {flag(scope, file, 'unexpected release file type'); return;}
  const key = hash + ':' + normalized;
  if (inspected.has(key)) return;
  inspected.add(key);
  const bytes = git(['cat-file', 'blob', hash], null);
  if (bytes.includes(0)) {flag(scope, file, 'binary content in source tree'); return;}
  let text;
  try {text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);} catch {flag(scope, file, 'non-UTF-8 release content'); return;}
  inspectText(scope, file, text);
}

function stagedEntries() {
  const entries = git(['ls-files', '--stage', '-z']).split('\0').filter(Boolean);
  return entries.flatMap(raw => {
    const match = /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]*)$/.exec(raw);
    if (!match) {flag('staged', '(index)', 'unrecognized Git index entry'); return [];}
    if (match[3] !== '0') {flag('staged', match[4], 'unresolved merge index'); return [];}
    return [{mode: match[1], hash: match[2], file: match[4]}];
  });
}

function historyEntries(commit) {
  return git(['ls-tree', '-r', '-z', commit]).split('\0').filter(Boolean).flatMap(raw => {
    const match = /^(\d+) (?:blob|commit) ([a-f0-9]+)\t([\s\S]*)$/.exec(raw);
    if (!match) {flag('history', commit.slice(0, 12), 'unrecognized Git tree entry'); return [];}
    return [{mode: match[1], hash: match[2], file: match[3]}];
  });
}

function audit() {
  const repoRoot = git(['rev-parse', '--show-toplevel']).trim();
  if (path.resolve(repoRoot).toLowerCase() !== cwd.toLowerCase()) throw new Error('Run the audit only from its isolated release repository.');
  const staged = stagedEntries();
  if (!staged.length) flag('staged', '(index)', 'no staged release files');
  for (const entry of staged) inspectBlob('staged', entry);
  const history = git(['rev-list', '--all', '--reflog', '--parents']).trim().split(/\r?\n/).filter(Boolean);
  for (const row of history) {
    const [commit] = row.split(' ');
    for (const field of ['%an', '%cn', '%B']) inspectText('history', commit.slice(0, 12), git(['show', '-s', `--format=${field}`, commit]));
    for (const field of ['%ae', '%ce']) inspectText('history', commit.slice(0, 12), git(['show', '-s', `--format=${field}`, commit]).trim(), {commitIdentity: true});
    for (const entry of historyEntries(commit)) inspectBlob('history', entry);
  }
  const unique = [...new Map(findings.map(finding => [JSON.stringify(finding), finding])).values()];
  const report = {ok: unique.length === 0, stagedFiles: staged.length, historyCommits: history.length, uniqueTextBlobs: inspected.size, privateTermCount: privateTerms.length, findings: unique};
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (!report.ok) process.exitCode = 1;
}

try {audit();} catch {
  process.stdout.write(JSON.stringify({ok: false, findings: [{scope: 'audit', file: '(repository)', rule: 'audit could not read the isolated staged tree or history'}]}, null, 2) + '\n');
  process.exitCode = 1;
}

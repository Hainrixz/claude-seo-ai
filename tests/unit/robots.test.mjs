// lib/robots.mjs — Google REP precedence matrix, group selection, fetch-status semantics, Content-Signal parsing.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  parseRobots, robotsFromFetch, selectGroup, isAllowed, aiPosture, signalsFor, pathMatcher, targetPath, uaToken, agentToken, parseContentSignalValue,
} from '../../scripts/lib/robots.mjs';
import { AI_BOTS, BOTS, UA_TABLE_VERSION, botByName, BOT_CLASSES } from '../../scripts/lib/bots.mjs';

const FIX = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const read = (f) => readFileSync(resolve(FIX, f), 'utf8');
const R = parseRobots(read('robots-precedence.txt'));
const allowed = (ua, path) => isAllowed(R, ua, path).allowed;

describe('parseRobots', () => {
  it('groups, sitemaps, host, clean-param, unknown directives, empty Disallow kept as a no-op rule', () => {
    assert.equal(R.groups.length, 6);
    assert.deepEqual(R.groups[0].agents, ['*']);
    assert.deepEqual(R.groups[4].agents, ['OAI-SearchBot', 'Claude-SearchBot'], 'consecutive User-agent lines share a group');
    assert.deepEqual(R.sitemaps, ['https://example.com/sitemap.xml']);
    assert.equal(R.host, 'example.com');
    assert.deepEqual(R.cleanParam, ['utm_source&utm_medium /']);
    assert.deepEqual(R.unknownDirectives.map((d) => d.field), ['noindex']);
    assert.ok(R.groups[0].rules.some((r) => r.type === 'disallow' && r.path === ''));
    assert.equal(R.hasBom, false);
    assert.equal(R.groups[5].crawlDelay, 7);
  });
  it('strips a BOM, keeps line numbers, ignores rules before any group and lines without a colon', () => {
    const r = parseRobots('﻿Disallow: /orphan\nnonsense line\nUser-agent: *\n\nDisallow: /a # trailing comment\n');
    assert.equal(r.hasBom, true);
    assert.equal(r.groups.length, 1);
    assert.deepEqual(r.groups[0].rules, [{ type: 'disallow', path: '/a', line: 5 }], 'blank lines do not end a group; inline comments are stripped');
    assert.equal(r.invalidLines.length, 2);
  });
  it('Sitemap between two User-agent lines separates the groups (Google parser behaviour)', () => {
    const r = parseRobots('User-agent: a\nSitemap: https://x/s.xml\nUser-agent: b\nDisallow: /\n');
    assert.equal(r.groups.length, 2);
    assert.equal(r.groups[0].rules.length, 0);
  });
});

describe('isAllowed — precedence matrix (Google REP)', () => {
  it('longest match wins', () => {
    assert.equal(allowed('*', '/admin/x'), false);
    assert.equal(allowed('*', '/admin/public/y'), true);
    assert.equal(allowed('*', '/fish.php'), false, '/fish*.php (11 chars) beats Allow: /fish (5)');
    assert.equal(allowed('*', '/fishheads'), true);
  });
  it('Allow wins a tie', () => {
    assert.equal(allowed('*', '/tie'), true);
    assert.equal(allowed('*', '/tie/x'), true);
  });
  it('* wildcard and $ end anchor, matched against path + query', () => {
    assert.equal(allowed('*', '/a.pdf'), false);
    assert.equal(allowed('*', '/dir/deep/a.pdf'), false);
    assert.equal(allowed('*', '/a.pdf?x=1'), true, '$ anchors the end: a query breaks the match');
    assert.equal(allowed('*', '/a.pdfx'), true);
    assert.equal(allowed('*', '/search?q=1'), false);
    assert.equal(allowed('*', '/search?q=allowed'), true, 'longer Allow with the same query prefix');
    assert.equal(allowed('*', '/search'), true, '"/search?" requires the literal ?');
    assert.equal(allowed('*', 'https://example.com/search?q=1'), false, 'full URLs work too');
  });
  it('prefix semantics and empty Disallow', () => {
    assert.equal(allowed('*', '/private-ok'), false, 'Disallow: /private is a prefix match');
    assert.equal(allowed('*', '/'), true);
    assert.equal(allowed('*', '/anything/else'), true, 'the empty Disallow imposes nothing');
  });
  it('reports the winning rule and how the group was chosen', () => {
    const v = isAllowed(R, 'SomeUnknownBot', '/admin/x');
    assert.equal(v.allowed, false);
    assert.equal(v.via, 'wildcard');
    assert.deepEqual(v.rule, { type: 'disallow', path: '/admin/', line: 3 });
    assert.equal(v.path, '/admin/x');
    const g = isAllowed(R, 'Googlebot', '/nogoogle/x');
    assert.equal(g.via, 'explicit');
    assert.equal(g.rule.path, '/nogoogle/');
  });
  it('non-ASCII paths are compared percent-encoded', () => {
    const r = parseRobots('User-agent: *\nDisallow: /café\n');
    assert.equal(isAllowed(r, '*', '/caf%C3%A9/x').allowed, false);
    assert.equal(isAllowed(r, '*', 'https://example.com/café').allowed, false);
  });
});

describe('selectGroup — token matching', () => {
  it('is case-insensitive and merges every group naming the same token', () => {
    const g = selectGroup(R, 'GOOGLEBOT');
    assert.equal(g.via, 'explicit');
    assert.equal(g.group.rules.length, 3);
    assert.equal(allowed('Googlebot', '/also-nogoogle/x'), false);
    assert.equal(allowed('Googlebot', '/admin/x'), true, 'own group (Allow: /) — the * group does not apply');
  });
  it('matches the product token inside a full User-Agent header value', () => {
    assert.equal(allowed('Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.4; +https://openai.com/gptbot', '/'), false);
    assert.equal(uaToken('Mozilla/5.0 (compatible; claude-seo-ai/0.2; +https://github.com/x)'), 'claude-seo-ai');
    assert.equal(uaToken('Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'), 'Googlebot');
    assert.equal(uaToken('SlowBot'), 'SlowBot');
    assert.equal(agentToken('Googlebot/2.1'), 'Googlebot');
    assert.equal(agentToken('* anything'), '*');
  });
  it('multi-agent groups apply to each listed token; unknown tokens fall back to *; no group at all allows', () => {
    assert.equal(allowed('Claude-SearchBot', '/drafts/x'), false);
    assert.equal(allowed('OAI-SearchBot', '/drafts/x'), false);
    assert.equal(allowed('OAI-SearchBot', '/admin/x'), true, 'explicit group means the * group is ignored entirely');
    assert.equal(selectGroup(R, 'NobodyBot').via, 'wildcard');
    const none = isAllowed(parseRobots('Sitemap: https://x/s.xml\n'), 'GPTBot', '/x');
    assert.deepEqual([none.allowed, none.via, none.rule], [true, 'no-group', null]);
  });
});

describe('robotsFromFetch — status semantics', () => {
  it('2xx parses, 4xx allows all, 5xx/429/network disallow all, 3xx leftover counts as not found', () => {
    assert.equal(robotsFromFetch({ status: 200, text: read('robots-precedence.txt') }).mode, 'parsed');
    assert.equal(robotsFromFetch({ status: 200, body: { text: 'User-agent: *\nDisallow: /x\n' } }).robots.groups.length, 1, 'fetchRaw-shaped body works');
    const notFound = robotsFromFetch({ status: 404, text: 'Not Found' });
    assert.equal(notFound.mode, 'allow-all');
    assert.deepEqual([isAllowed(notFound, 'Googlebot', '/x').allowed, isAllowed(notFound, 'Googlebot', '/x').via], [true, 'status-4xx']);
    for (const status of [500, 503, 429]) {
      const r = robotsFromFetch({ status, text: '' });
      assert.equal(r.mode, 'disallow-all', 'status ' + status);
      assert.deepEqual([isAllowed(r, 'GPTBot', '/').allowed, isAllowed(r, 'GPTBot', '/').via], [false, 'status-5xx']);
    }
    assert.equal(robotsFromFetch({ status: 0, error: 'ECONNREFUSED' }).mode, 'disallow-all');
    assert.equal(robotsFromFetch(null).mode, 'disallow-all');
    assert.equal(robotsFromFetch({ status: 302, text: '' }).mode, 'allow-all');
  });
});

describe('pathMatcher / targetPath', () => {
  it('compiles wildcards and anchors, caches, and normalizes targets', () => {
    assert.equal(pathMatcher('/*.php$')('/a/b.php'), true);
    assert.equal(pathMatcher('/*.php$')('/a/b.php?x'), false);
    assert.equal(pathMatcher('/a*b*c')('/aXXbYYc'), true);
    assert.equal(pathMatcher('/x')('/y'), false);
    assert.equal(pathMatcher('/x'), pathMatcher('/x'), 'cached');
    assert.equal(targetPath('https://example.com/a/b?q=1#frag'), '/a/b?q=1');
    assert.equal(targetPath('/a b'), '/a%20b');
    assert.equal(targetPath(''), '/');
    assert.equal(targetPath('example.com/x'), '/x');
  });
});

describe('Content-Signal parsing', () => {
  it('global placement after all groups, with the Cloudflare hint from a preceding comment', () => {
    const r = parseRobots(read('robots-content-signal.txt'));
    const cs = r.contentSignals;
    assert.equal(cs.present, true);
    assert.equal(cs.placement, 'global');
    assert.deepEqual(cs.global, { search: 'yes', 'ai-input': 'no', 'ai-train': 'no', raw: 'search=yes, ai-input=no, ai-train=no' });
    assert.deepEqual(cs.by_group, []);
    assert.deepEqual(cs.malformed, []);
    assert.equal(cs.cloudflare_managed_hint, true);
    assert.deepEqual(signalsFor(r, 'GPTBot'), { search: 'yes', 'ai-input': 'no', 'ai-train': 'no' }, 'global applies to every bot');
    assert.deepEqual(signalsFor(r, 'Bingbot'), { search: 'yes', 'ai-input': 'no', 'ai-train': 'no' });
  });
  it('group placement: a line directly after a group applies to that group only; malformed pairs are reported, valid ones kept', () => {
    const r = parseRobots(read('robots-content-signal-group.txt'));
    const cs = r.contentSignals;
    assert.equal(cs.placement, 'group');
    assert.equal(cs.global, null);
    assert.equal(cs.by_group.length, 3);
    assert.deepEqual(cs.by_group[0].agents, ['GPTBot']);
    assert.deepEqual(cs.by_group[0].signals, { search: null, 'ai-input': null, 'ai-train': 'no' });
    assert.equal(cs.cloudflare_managed_hint, false);
    assert.deepEqual(signalsFor(r, 'GPTBot'), { search: null, 'ai-input': null, 'ai-train': 'no' });
    assert.deepEqual(signalsFor(r, 'OAI-SearchBot'), { search: 'yes', 'ai-input': 'yes', 'ai-train': null });
    assert.deepEqual(signalsFor(r, 'Bingbot'), { search: 'yes', 'ai-input': null, 'ai-train': null }, 'falls back to the * group line');
    assert.deepEqual(cs.malformed.map((m) => m.reason), [
      'invalid value "maybe" for ai-input (expected yes|no)',
      'unknown key "foo" (expected search|ai-input|ai-train)',
      'missing "=" in "ai-train"',
    ]);
    assert.ok(cs.malformed.every((m) => m.line === 11));
  });
  it('both placements, a line before any group, absent signals, and the value parser edge cases', () => {
    const both = parseRobots('User-agent: GPTBot\nDisallow: /\nContent-Signal: ai-train=no\n\nContent-Signal: search=yes\n');
    assert.equal(both.contentSignals.placement, 'both');
    assert.deepEqual(signalsFor(both, 'GPTBot'), { search: null, 'ai-input': null, 'ai-train': 'no' }, 'group line wins over global for its agents');
    assert.deepEqual(signalsFor(both, 'Googlebot'), { search: 'yes', 'ai-input': null, 'ai-train': null });
    const before = parseRobots('Content-Signal: search=yes\nUser-agent: *\nAllow: /\n');
    assert.equal(before.contentSignals.placement, 'global');
    const separated = parseRobots('User-agent: *\nDisallow: /a\n\nContent-Signal: ai-train=no\n');
    assert.equal(separated.contentSignals.placement, 'global', 'a blank line breaks group placement');
    const commentBreak = parseRobots('User-agent: *\nDisallow: /a\n# note\nContent-Signal: ai-train=no\n');
    assert.equal(commentBreak.contentSignals.placement, 'global', 'a comment-only line breaks group placement');
    const none = parseRobots('User-agent: *\nAllow: /\n');
    assert.equal(none.contentSignals.present, false);
    assert.equal(none.contentSignals.placement, null);
    assert.equal(signalsFor(none, 'GPTBot'), 'unset');
    assert.equal(signalsFor(robotsFromFetch({ status: 503 }), 'GPTBot'), 'unset');
    const v = parseContentSignalValue('SEARCH=YES, ai-train=No, search=no,', 7);
    assert.deepEqual(v.signals, { search: 'no', 'ai-input': null, 'ai-train': 'no' });
    assert.deepEqual(v.malformed.map((m) => m.reason), ['duplicate key "search"', 'empty pair (stray comma)']);
    assert.equal(parseContentSignalValue('', 1).malformed[0].reason, 'empty Content-Signal value');
  });
});

describe('aiPosture + bots table', () => {
  it('reports root/url allowance, via, rule and signals per class for every bot in the table', () => {
    const r = parseRobots(read('robots-content-signal.txt'));
    const p = aiPosture(r, 'https://example.com/admin/page');
    assert.deepEqual(Object.keys(p), BOT_CLASSES);
    assert.equal(p.training.GPTBot.root_allowed, false);
    assert.equal(p.training.GPTBot.url_allowed, false);
    assert.equal(p.training.GPTBot.via, 'explicit');
    assert.equal(p.retrieval['OAI-SearchBot'].root_allowed, true);
    assert.equal(p.retrieval['OAI-SearchBot'].url_allowed, false, '/admin/ disallowed via *');
    assert.equal(p.retrieval['OAI-SearchBot'].via, 'wildcard');
    assert.deepEqual(p.search.Googlebot.signals, { search: 'yes', 'ai-input': 'no', 'ai-train': 'no' });
    assert.equal(aiPosture(r).search.Googlebot.url_allowed, null, 'no URL → url_allowed is null, never fabricated');
    assert.equal(aiPosture(robotsFromFetch({ status: 500 })).training.ClaudeBot.root_allowed, false);
  });
  it('the UA table has the 24 documented bots, legacy 15 included, with sources or explicit TODO nulls', () => {
    assert.equal(UA_TABLE_VERSION, '2026-09');
    assert.equal(BOTS.length, 24);
    for (const legacy of ['GPTBot', 'ClaudeBot', 'Google-Extended', 'Applebot-Extended', 'CCBot', 'Meta-ExternalAgent', 'Bytespider', 'OAI-SearchBot',
      'Claude-SearchBot', 'PerplexityBot', 'ChatGPT-User', 'Perplexity-User', 'Claude-User', 'Googlebot', 'Bingbot']) assert.ok(botByName(legacy), legacy);
    for (const added of ['Amazonbot', 'Claude-Web', 'Applebot', 'Google-CloudVertexBot', 'DuckAssistBot', 'Meta-ExternalFetcher', 'MistralAI-User', 'cohere-ai', 'OAI-AdsBot']) assert.ok(botByName(added), added);
    assert.equal(botByName('amazonbot').class, 'retrieval');
    assert.equal(botByName('OAI-AdsBot').class, 'other');
    assert.deepEqual(AI_BOTS.search, ['Googlebot', 'Bingbot', 'Applebot']);
    for (const b of BOTS) {
      assert.ok(BOT_CLASSES.includes(b.class), b.name + ' class');
      assert.ok(b.doc_url === null || /^https:\/\//.test(b.doc_url), b.name + ' doc_url');
      assert.ok(['documented', 'limited', 'unreliable', 'unknown'].includes(b.robots_reliability), b.name + ' reliability');
    }
    assert.equal(botByName('nope'), null);
  });
});

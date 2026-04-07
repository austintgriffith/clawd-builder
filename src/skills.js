import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { log } from './logger.js';

const SKILL_URLS = {
  'ethskills-root':          'https://ethskills.com/SKILL.md',
  'ethskills-ship':          'https://ethskills.com/ship/SKILL.md',
  'ethskills-orchestration': 'https://ethskills.com/orchestration/SKILL.md',
  'ethskills-standards':     'https://ethskills.com/standards/SKILL.md',
  'ethskills-security':      'https://ethskills.com/security/SKILL.md',
  'ethskills-frontend-ux':   'https://ethskills.com/frontend-ux/SKILL.md',
  'ethskills-frontend-playbook': 'https://ethskills.com/frontend-playbook/SKILL.md',
  'ethskills-concepts':      'https://ethskills.com/concepts/SKILL.md',
  'ethskills-testing':        'https://ethskills.com/testing/SKILL.md',
  'scaffold-eth':            'https://docs.scaffoldeth.io/SKILL.md',
  'scaffold-eth-agents':     'https://raw.githubusercontent.com/scaffold-eth/scaffold-eth-2/main/AGENTS.md',
  'bgipfs':                  'https://www.bgipfs.com/SKILL.md',
};

async function fetchWithRetry(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      if (i === retries - 1) throw err;
      log(`Retry ${i + 1}/${retries} for ${url}: ${err.message}`);
      await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    }
  }
}

export async function fetchAllSkills(buildDir) {
  const skillsDir = join(buildDir, 'skills');
  mkdirSync(skillsDir, { recursive: true });

  const skills = {};
  const entries = Object.entries(SKILL_URLS);

  log(`Fetching ${entries.length} SKILL.md files...`);

  const results = await Promise.allSettled(
    entries.map(async ([name, url]) => {
      const content = await fetchWithRetry(url);
      return { name, url, content };
    })
  );

  for (const result of results) {
    if (result.status === 'fulfilled') {
      const { name, url, content } = result.value;
      skills[name] = content;
      writeFileSync(join(skillsDir, `${name}.md`), content);
      log(`  OK: ${name} (${content.length} chars)`);
    } else {
      log(`  FAIL: ${result.reason?.message || 'unknown error'}`);
    }
  }

  log(`Fetched ${Object.keys(skills).length}/${entries.length} skills`);
  return skills;
}

export function buildSkillContext(skills, keys, maxPerSkill = 3000) {
  const parts = [];
  for (const key of keys) {
    if (skills[key]) {
      const text = skills[key].length > maxPerSkill
        ? skills[key].slice(0, maxPerSkill) + '\n\n[... truncated, see full file in skills/ folder]'
        : skills[key];
      parts.push(`--- ${key} ---\n${text}`);
    }
  }
  return parts.join('\n\n');
}

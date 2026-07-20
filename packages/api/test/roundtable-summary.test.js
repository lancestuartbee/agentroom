import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { allCritiquesSettled, buildFinalSummary, isLikelyNewRoundtableTopic, parseCritiqueMeta, planRoundtableAction } =
  await import(
  '../dist/domains/cats/services/agents/routing/route-roundtable.js'
);

function extractSummarySection(text, title) {
  const lines = text.split(/\r?\n/);
  let collecting = false;
  const body = [];
  for (const line of lines) {
    const heading = /^(#{2,4})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      if (collecting) break;
      collecting = heading[2]?.trim() === title;
      continue;
    }
    if (collecting) body.push(line);
  }
  return body.join('\n').trim();
}

describe('roundtable final summary', () => {
  it('summarizes outcomes without replaying stance and critique transcripts', () => {
    const summary = buildFinalSummary(
      '是否推进新圆桌会议模式',
      ['codex', 'opus'],
      new Map([
        [
          'codex',
          [
            '## 我的立场',
            '可以推进新圆桌会议模式。',
            '',
            '## 理由',
            '这是一段很长的独立立场原文，最终总结不应该把它完整复述出来。',
          ].join('\n'),
        ],
      ]),
      [
        new Map([
          [
            'opus',
            '## 收到的挑战与回应\n这是一段互评循环原文，最终总结不应该把它完整复述出来。',
          ],
        ]),
      ],
      new Map([
        ['codex', 'VOTE: accept\n\n## 投票理由\n可以推进，但需要保留清晰的阶段状态。'],
        ['opus', 'VOTE: reject\n\n## 条件或阻塞\n总结不能复制每个人的过程发言。'],
      ]),
    );

    assert.match(summary, /## 会议结论/);
    assert.match(summary, /## 投票记录/);
    assert.match(summary, /## 少数或保留观点/);
    assert.doesNotMatch(summary, /独立立场记录/);
    assert.doesNotMatch(summary, /互评收束记录/);
    assert.doesNotMatch(summary, /很长的独立立场原文/);
    assert.doesNotMatch(summary, /互评循环原文/);
  });

  it('summarizes topic answers instead of who convinced whom', () => {
    const summary = buildFinalSummary(
      '是否采用 A 方案',
      ['codex', 'opus'],
      new Map(),
      [],
      new Map([
        [
          'codex',
          [
            'VOTE: accept',
            '',
            '## 我对议题的最终回答',
            '应该采用 A 方案，并先做一周灰度。',
            '',
            '## 投票理由',
            '我最终赞同了 opus 的表达。',
          ].join('\n'),
        ],
        [
          'opus',
          [
            'VOTE: accept',
            '',
            '## 我对议题的最终回答',
            '应该采用 A 方案，但上线前要保留回滚条件。',
            '',
            '## 投票理由',
            'codex 的补充让我改变了措辞。',
          ].join('\n'),
        ],
      ]),
    );

    const conclusion = extractSummarySection(summary, '会议结论');
    assert.match(conclusion, /应该采用 A 方案/);
    assert.doesNotMatch(conclusion, /赞同了 opus/);
    assert.doesNotMatch(conclusion, /改变了措辞/);
  });
});

describe('roundtable critique loop settling', () => {
  it('continues when blockers remain even without a new challenge or stance change', () => {
    const outputs = new Map([
      [
        'codex',
        [
          'CHANGE: no',
          'NEW_CHALLENGE: no',
          'READY_TO_VOTE: no',
          'BLOCKER: yes',
          '',
          '## 收到的挑战与回应',
          '证据不足，关键分歧仍未解决。',
        ].join('\n'),
      ],
      [
        'opus',
        [
          'CHANGE: no',
          'NEW_CHALLENGE: no',
          'READY_TO_VOTE: no',
          'BLOCKER: yes',
          '',
          '## 我仍然反对的论点',
          '仍然反对直接进入投票。',
        ].join('\n'),
      ],
    ]);

    assert.equal(allCritiquesSettled(outputs), false);
  });

  it('settles only when every participant is ready to vote with no blockers', () => {
    const outputs = new Map([
      [
        'codex',
        [
          'CHANGE: no',
          'NEW_CHALLENGE: no',
          'READY_TO_VOTE: yes',
          'BLOCKER: no',
          '',
          '## 收到的挑战与回应',
          '可以进入投票。',
        ].join('\n'),
      ],
      [
        'opus',
        [
          'CHANGE: no',
          'NEW_CHALLENGE: no',
          'READY_TO_VOTE: yes',
          'BLOCKER: no',
          '',
          '## 当前立场是否变化',
          '无变化，可以进入投票。',
        ].join('\n'),
      ],
    ]);

    assert.equal(allCritiquesSettled(outputs), true);
  });

  it('parses explicit ready and blocker control lines', () => {
    assert.deepEqual(parseCritiqueMeta('CHANGE: no\nNEW_CHALLENGE: no\nREADY_TO_VOTE: yes\nBLOCKER: no'), {
      changed: false,
      newChallenge: false,
      readyToVote: true,
      blocker: false,
    });
  });

  it('parses localized critique control lines', () => {
    assert.deepEqual(parseCritiqueMeta('立场变化：否\n新挑战：无\n准备投票：是\n仍有阻塞：否'), {
      changed: false,
      newChallenge: false,
      readyToVote: true,
      blocker: false,
    });
  });

  it('infers critique metadata from prose when models omit control lines', () => {
    assert.deepEqual(
      parseCritiqueMeta(
        [
          '## 立场修订',
          '我接受对方批评并修正为最小可用交接。',
          '',
          '## 新的挑战',
          '仍有证据不足的问题。',
          '',
          '## 仍未消除的不确定性',
          '会议是否可延期尚不明确。',
        ].join('\n'),
      ),
      {
        changed: true,
        newChallenge: true,
        readyToVote: false,
        blocker: true,
      },
    );
  });
});

describe('roundtable action planning', () => {
  const summarizedIssue = {
    v: 1,
    issueId: 'roundtable-test',
    threadId: 'thread-test',
    topic: '是否采用 A 方案',
    status: 'summarized',
    stage: 'final_summary',
    critiqueRound: 2,
    maxCritiqueRounds: 5,
    participants: ['codex', 'opus'],
    updatedAt: Date.now(),
  };

  it('does not start a full roundtable for lightweight follow-up messages', () => {
    assert.equal(isLikelyNewRoundtableTopic('今天星期几', summarizedIssue), false);
    assert.equal(planRoundtableAction('今天星期几', ['codex', 'opus'], summarizedIssue).action, 'single_response');
  });

  it('routes post-summary save requests to artifact saving', () => {
    assert.equal(planRoundtableAction('把刚才的会议结论保存成 markdown 报告', ['codex', 'opus'], summarizedIssue).action, 'artifact_request');
  });
});

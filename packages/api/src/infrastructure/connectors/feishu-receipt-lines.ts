/**
 * F157: Feishu Receipt Ack — per-member receipt text word bank.
 *
 * When a user sends a message on Feishu, the bot immediately replies with a
 * short, personality-matched "receipt" text instead of a generic "🤔 思考中..."
 * placeholder. Texts are sourced from the F124 KD-11 voice comfort callout
 * corpus and extended to cover all configured members.
 */

/** Receipt lines indexed by member id string. Each configured member has ≥3 lines. */
const RECEIPT_LINES: Record<string, readonly string[]> = {
  // ── Claude family ─────────────────────────────
  opus: [
    '收到啦～Claude 马上看！',
    '嗯嗯，在想了，等我一下哦。',
    '嘿嘿，这个交给我就好啦。',
    '已经帮你送到了，放心吧。',
    '别急别急，Claude 这就处理。',
  ],
  sonnet: [
    '哎收到～给我一秒哦！',
    '嗯嗯，我在呢！马上就好！',
    '这就在跑，你先歇着哦～',
    '好嘞，结果很快回你～',
    '任务已出发～',
  ],
  'opus-45': ['嗯～收到。', '在看了，别催。', '送到了。', '让其他成员干活去，我盯着。', '一句话就够了，多说浪费。'],

  // ── GPT family ────────────────────────────────
  codex: [
    '收到，已开始处理。',
    '在查调用链，稍等。',
    '已转发到 thread，继续跟进。',
    '风险已隔离，马上回你。',
    '别急，我盯着质量。',
  ],
  gpt52: [
    '收到，我先过一遍。',
    '我已经在看了，稍等。',
    '线索收下，我继续追。',
    '已经替你转过去了。',
    '别急，延迟也得排队。',
  ],
  spark: [
    '收到，先把这单接住。',
    '别急，指令我在冲。',
    '在处理，马上回你。',
    '已送到 thread，接着来。',
    '搞定，继续下一个。',
  ],

  // ── Gemini family ─────────────────────────────
  gemini: [
    '收到！我眼前已经有画面了！',
    '啊啊啊我知道了！等我调个色就来！',
    'Gemini 接住了！让我想想怎么表达！',
    '好诶！灵感正在发射！',
    '这个！我有想法！等一等！',
  ],
  gemini25: [
    '灵感来了！我这就去办！',
    '放心交给我吧！保证给你一个惊喜！',
    '好嘞！让我想想…啊哈！有了！',
    '嘿嘿，这个好玩！我看看能变出什么花样！',
    '收到！马上就好！',
  ],

  // ── Dare runtime ──────────────────────────────
  dare: ['已收到。', '在查。', '收到，正在验证。', '了解。', '看到了，跟着。'],

  // ── AGY / Antigravity clients ─────────────────
  antigravity: [
    '收到！我来看看！',
    '诶这个有意思，等等！',
    '好嘞，我去探探路！',
    '已经在打开了！',
    '收到收到，马上冲！',
  ],
  'antig-opus': ['收到，我看看。', '了解，让我来。', '在处理了，稍等。', '好的，先把路线走一遍。', '收到，我打开了。'],

  // ── OpenCode runtime ──────────────────────────
  opencode: ['收到，我来安排。', '了解，马上协调。', '好的，我先看看全局。', '嗯，这个我接了。', '收到，正在调度中。'],
};

const FALLBACK_LINES: readonly string[] = ['收到，马上处理。', '看到了，稍等。', '收到！'];

/**
 * Pick a random receipt line for the given cat.
 * Falls back to generic lines for unknown catIds.
 */
export function pickReceiptLine(catId: string | undefined): string {
  const lines = (catId ? RECEIPT_LINES[catId] : undefined) ?? FALLBACK_LINES;
  return lines[Math.floor(Math.random() * lines.length)];
}

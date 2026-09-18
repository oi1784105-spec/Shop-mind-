// 演示模式的预置数据与回答生成。
//
// 数据设计目标：让每个界面都有内容可看，并且能演示产品的关键机制——
// 尤其是「文档解析中 → 已完成，发布按钮随之点亮」这条链路。
// 所有内容都在浏览器本地生成，不调用 RAGFlow、模型或任何后端服务。

import type {
  Conversation,
  KnowledgeBase,
  KnowledgeDocument,
  KnowledgeVersion,
  Message,
  Reference,
} from '../types';

/** 演示账号：登录页会预填（通过 shopmind-remembered-username），任意非空账号均可登录。 */
export const DEMO_ACCOUNT = {
  username: 'admin',
  password: 'shopmind2026',
  display_name: '系统管理员',
};

/** 上传的文档多久解析完成（毫秒），用于演示解析状态轮询。 */
export const PARSE_DURATION_MS = 12_000;

const now = Date.now();
const iso = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();

// ---------------------------------------------------------------------------
// 知识库
// ---------------------------------------------------------------------------

export const SEED_KNOWLEDGE_BASES: Array<{
  base: KnowledgeBase;
  versions: Array<KnowledgeVersion & { documents: KnowledgeDocument[] }>;
}> = [
  {
    base: {
      id: 'kb-after-sales',
      name: '售后与退换货规则',
      description: '商品质量、七天无理由、拆封验货与退款时效的统一口径。',
      active_version_id: 'kb-after-sales-v2',
      active_version_number: 2,
      active_version_status: 'active',
      version_count: 2,
      updated_at: iso(180),
    },
    versions: [
      {
        id: 'kb-after-sales-v2',
        knowledge_base_id: 'kb-after-sales',
        version_number: 2,
        status: 'active',
        document_count: 2,
        name: '2026 春季版',
        created_at: iso(1_500),
        published_at: iso(1_440),
        documents: [
          {
            id: 'doc-return-policy',
            name: '退货政策说明.md',
            size: 24_500,
            status: 'DONE',
            progress: 1,
            error_message: '',
            created_at: iso(1_500),
          },
          {
            id: 'doc-refund-sla',
            name: '退款时效与到账说明.pdf',
            size: 512_000,
            status: 'DONE',
            progress: 1,
            error_message: '',
            created_at: iso(1_495),
          },
        ],
      },
      {
        id: 'kb-after-sales-v1',
        knowledge_base_id: 'kb-after-sales',
        version_number: 1,
        status: 'archived',
        document_count: 2,
        name: '历史版本',
        created_at: iso(20_000),
        published_at: iso(19_800),
        documents: [
          {
            id: 'doc-return-old',
            name: '退货政策（旧）.md',
            size: 21_000,
            status: 'DONE',
            progress: 1,
            error_message: '',
            created_at: iso(20_000),
          },
          {
            id: 'doc-after-sales-faq',
            name: '售后常见问题.docx',
            size: 88_000,
            status: 'DONE',
            progress: 1,
            error_message: '',
            created_at: iso(19_990),
          },
          {
            // 故意保留一份解析失败的文档：用来展示失败徽标与红色错误说明。
            // 放在归档版本里，这样草稿版本仍能正常走完「解析完成 → 发布」的流程。
            id: 'doc-legacy-price',
            name: '旧版价格表.xlsx',
            size: 512,
            status: 'FAIL',
            progress: 0,
            error_message: '解析失败：文档已加密，无法读取内容。',
            created_at: iso(19_980),
          },
        ],
      },
    ],
  },
  {
    base: {
      id: 'kb-campaign',
      name: '活动与优惠券政策',
      description: '大促活动规则、优惠券叠加与使用门槛说明。',
      active_version_id: null,
      active_version_number: null,
      active_version_status: null,
      version_count: 1,
      updated_at: iso(12),
    },
    versions: [
      {
        id: 'kb-campaign-v1',
        knowledge_base_id: 'kb-campaign',
        version_number: 1,
        status: 'draft',
        document_count: 4,
        name: '大促规则草稿',
        created_at: iso(25),
        published_at: null,
        documents: [
          {
            id: 'doc-coupon-stack',
            name: '优惠券叠加规则.pdf',
            size: 3_400_000,
            status: 'RUNNING',
            progress: 0.35,
            error_message: '',
            created_at: iso(10),
          },
          {
            id: 'doc-campaign-timing',
            name: '大促时间与库存说明.md',
            size: 32_000,
            status: 'UNSTART',
            progress: 0,
            error_message: '',
            created_at: iso(9),
          },
          {
            id: 'doc-presale',
            name: '预售发货说明.docx',
            size: 88_000,
            status: 'DONE',
            progress: 1,
            error_message: '',
            created_at: iso(24),
          },
        ],
      },
    ],
  },
  {
    base: {
      id: 'kb-logistics',
      name: '物流与配送时效',
      description: '',
      active_version_id: 'kb-logistics-v1',
      active_version_number: 1,
      active_version_status: 'active',
      version_count: 1,
      updated_at: iso(2_600),
    },
    versions: [
      {
        id: 'kb-logistics-v1',
        knowledge_base_id: 'kb-logistics',
        version_number: 1,
        status: 'active',
        document_count: 2,
        name: '正式版',
        created_at: iso(3_000),
        published_at: iso(2_900),
        documents: [
          {
            id: 'doc-shipping-sla',
            name: '配送时效与运费规则.md',
            size: 46_000,
            status: 'DONE',
            progress: 1,
            error_message: '',
            created_at: iso(3_000),
          },
          {
            id: 'doc-remote-area',
            name: '偏远地区配送说明.pdf',
            size: 780_000,
            status: 'DONE',
            progress: 1,
            error_message: '',
            created_at: iso(2_995),
          },
        ],
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// 会话与消息
// ---------------------------------------------------------------------------

function reference (id: string, keyword: string, content: string): Reference {
  return { id, document_keyword: keyword, content };
}

const RETURN_ANSWER = [
  '依据《退货政策说明》，拆封后是否支持退货要看商品类型',
  '普通商品支持七天无理由退货，拆封查验不影响退货权利；',
  '定制类、生鲜类与已激活的数码产品不在七天无理由范围内；',
  '退货需保持商品主体、配件与赠品完整，包装破损不构成拒收理由；',
  '审核通过后的退款按原支付渠道退回，一般 1 至 3 个工作日到账。',
].join('');

const COUPON_ANSWER = [
  '活动优惠与会员券的叠加规则在《优惠券叠加规则》中有明确约定',
  '同一订单中平台券与店铺券可以叠加使用，但同类券不可叠加；',
  '会员专享券视为店铺券的一种，是否可以叠加取决于活动配置；',
  '叠加后的订单金额不得低于活动的保底价，否则系统会自动取消最低优先级的那张券。',
].join('');

export const SEED_CONVERSATIONS: Array<{ conversation: Conversation; messages: Message[] }> = [
  {
    conversation: {
      id: 'conv-return',
      title: '商品拆封后是否支持退货？',
      knowledge_base_id: 'kb-after-sales',
      knowledge_base_name: '售后与退换货规则',
      knowledge_version_id: 'kb-after-sales-v2',
      updated_at: iso(150),
    },
    messages: [
      {
        id: 'msg-return-1',
        role: 'user',
        content: '商品拆封后是否支持退货？',
        references: [],
        created_at: iso(152),
      },
      {
        id: 'msg-return-2',
        role: 'assistant',
        content: RETURN_ANSWER,
        references: [
          reference(
            'ref-return-1',
            '退货政策说明.md',
            '普通商品自签收之日起七日内，在不影响二次销售的前提下支持无理由退货；拆封查验不属于影响二次销售。',
          ),
          reference(
            'ref-return-2',
            '退货政策说明.md',
            '以下商品不适用七天无理由退货：定制类商品；鲜活易腐类商品；已激活或已拆封的数码产品；已拆封的音像制品与软件。',
          ),
          reference(
            'ref-return-3',
            '退款时效与到账说明.pdf',
            '退款审核通过后按原支付渠道退回；银行卡支付一般 1 至 3 个工作日到账，第三方支付以渠道到账时间为准。',
          ),
        ],
        created_at: iso(150),
      },
    ],
  },
  {
    conversation: {
      id: 'conv-coupon',
      title: '活动优惠能否与会员券叠加？',
      knowledge_base_id: 'kb-campaign',
      knowledge_base_name: '活动与优惠券政策',
      knowledge_version_id: null,
      updated_at: iso(40),
    },
    messages: [
      {
        id: 'msg-coupon-1',
        role: 'user',
        content: '活动优惠能否与会员券叠加？',
        references: [],
        created_at: iso(42),
      },
      {
        id: 'msg-coupon-2',
        role: 'assistant',
        content: COUPON_ANSWER,
        references: [
          reference(
            'ref-coupon-1',
            '优惠券叠加规则.pdf',
            '同一订单中，平台券与店铺券可叠加使用；同类券（含会员专享券）不可叠加，系统按下单时优先级最高的一张生效。',
          ),
          reference(
            'ref-coupon-2',
            '预售发货说明.docx',
            '预售商品在支付尾款后参与活动优惠计算，预售定金不参与叠加抵扣。',
          ),
        ],
        created_at: iso(40),
      },
    ],
  },
  {
    conversation: {
      id: 'conv-logistics',
      title: '预售商品什么时候可以发货？',
      knowledge_base_id: 'kb-logistics',
      knowledge_base_name: '物流与配送时效',
      knowledge_version_id: 'kb-logistics-v1',
      updated_at: iso(2_500),
    },
    messages: [
      {
        id: 'msg-logistics-1',
        role: 'user',
        content: '预售商品什么时候可以发货？',
        references: [],
        created_at: iso(2_502),
      },
      {
        id: 'msg-logistics-2',
        role: 'assistant',
        content: [
          '预售商品的发货时间以商品页标注的发货日期为准；',
          '支付尾款后订单转为待发货状态，一般在该日期起 48 小时内出库；',
          '偏远地区因配送线路限制，时效会在标准时效基础上顺延 1 至 2 天。',
        ].join(''),
        references: [
          reference(
            'ref-logistics-1',
            '配送时效与运费规则.md',
            '现货订单在当日 16:00 前支付，通常当日出库；16:00 后顺延至次日。预售订单以商品页标注的发货时间为准。',
          ),
          reference(
            'ref-logistics-2',
            '偏远地区配送说明.pdf',
            '新疆、西藏及部分海岛地区配送时效在标准基础上顺延 1 至 2 天，具体以下单页展示为准。',
          ),
        ],
        created_at: iso(2_500),
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// 回答生成
// ---------------------------------------------------------------------------

type Topic = {
  match: RegExp;
  answer: string;
  keywords: string[];
};

const TOPICS: Topic[] = [
  {
    match: /(退货|退款|售后|拆封|换货|七天)/,
    answer: RETURN_ANSWER,
    keywords: ['退货', '退款', '售后', '政策', '时效'],
  },
  {
    match: /(优惠券|叠加|活动|大促|满减|折扣|会员券|预售)/,
    answer: COUPON_ANSWER,
    keywords: ['优惠券', '叠加', '规则', '预售'],
  },
  {
    match: /(物流|配送|发货|快递|运费|时效|偏远)/,
    answer: [
      '依据《配送时效与运费规则》，发货与到货时间按订单类型区分',
      '现货订单在当日 16:00 前支付通常当日出库，之后顺延至次日；',
      '预售订单以商品页标注的发货日期为准，尾款支付后 48 小时内出库；',
      '偏远地区配送时效会顺延 1 至 2 天，运费按区域标准计算。',
    ].join(''),
    keywords: ['配送', '时效', '运费', '偏远'],
  },
];

const DEFAULT_TOPIC: Topic = {
  match: /.*/,
  answer: [
    '已从已发布的知识库中检索到相关规则',
    '当前演示数据只覆盖售后、活动与物流三类企业规则；',
    '如果你的问题属于其他业务范围，可以在「知识中心」新建知识库、上传规则文档并发布版本后再试。',
  ].join(''),
  keywords: [],
};

function pickTopic(question: string): Topic {
  return TOPICS.find((topic) => topic.match.test(question)) ?? DEFAULT_TOPIC;
}

/**
 * 依据提问与所选知识库生成回答依据。
 * 只在被选中的知识库里找文档，这一点与产品的「知识依据优先」定位一致。
 */
export function buildReferences(
  question: string,
  documents: Array<{ name: string; knowledgeBaseName: string }>,
): Reference[] {
  const topic = pickTopic(question);
  // 文档名或所属知识库名命中主题关键词的优先引用；都没命中时退回全部候选，
  // 保证「选了知识库就一定有依据可展示」。
  const pool = documents.filter((document) => {
    if (topic.keywords.length === 0) return true;
    const haystack = `${document.name}${document.knowledgeBaseName}`;
    return topic.keywords.some((keyword) => haystack.includes(keyword));
  });
  const chosen = (pool.length ? pool : documents).slice(0, 4);

  const contents = [
    '相关条款明确了适用条件与例外情形，客服答复时应同时说明适用前提，避免只引用结论。',
    '该规则自发布版本起生效，历史版本仅用于追溯，不再作为回复依据。',
    '如需人工复核，请以知识中心中当前生效版本的原文为准。',
    '本条款与活动规则冲突时，优先级以活动页面的特别说明为准。',
  ];

  return chosen.map((document, index) => ({
    id: `ref-live-${index}-${Math.random().toString(36).slice(2, 8)}`,
    document_keyword: document.name,
    content: `${document.knowledgeBaseName}：${contents[index % contents.length]}`,
  }));
}

/** 生成一条客服回答（非检索结果，仅用于演示交互）。 */
export function buildAnswer(question: string, referenceCount: number): string {
  const topic = pickTopic(question);
  if (referenceCount > 0) return topic.answer;
  return [
    '当前没有检索到可直接引用的企业规则',
    '为了避免给出不准确的答复，这里不编造结论；',
    '建议先在「知识中心」上传对应的规则文档并发布版本，或调整参考知识库的选择范围。',
  ].join('');
}

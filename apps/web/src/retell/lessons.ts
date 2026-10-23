import { z } from 'zod';

const sourceSchema = z.object({ title: z.string().min(1), publisher: z.string().min(1), url: z.url().refine(value => value.startsWith('https://')) }).strict();
const lessonSchema = z.object({
  id: z.string().regex(/^[a-z-]+$/), title: z.string().min(1).max(100), chineseTitle: z.string().min(1).max(80), topic: z.string().min(1),
  introduction: z.string().min(1), paragraphs: z.array(z.string().min(1).max(1500)).min(2).max(4),
  points: z.array(z.string().min(1).max(160)).min(3).max(5), references: z.tuple([z.string().min(1).max(1500), z.string().min(1).max(1500)]),
  pitfalls: z.array(z.string().min(1).max(240)).min(1).max(3), phrases: z.array(z.object({ text: z.string(), meaning: z.string() }).strict()).max(4), sources: z.array(sourceSchema).min(1).max(3),
}).strict();
export type RetellLesson = z.infer<typeof lessonSchema>;
export const lessonVersion = 'retell-editorial-20261022-v1';
export const lessons = z.array(lessonSchema).parse([
  {
    id: 'shorter-week', title: 'A shorter working week', chineseTitle: '更短的工作周', topic: '工作与生活', introduction: '工作时间缩短，怎样兼顾员工状态与服务质量？',
    paragraphs: [
      'A shorter working week is not necessarily a longer weekend created by squeezing the same hours into fewer days. Some employers are testing a genuine reduction in working hours while keeping pay unchanged. This requires them to rethink how work is organised, rather than simply asking people to work faster.',
      'During a six-month British trial, many employees reported less stress, and most participating companies wanted to continue the arrangement. Teams had tried changes such as shorter meetings and clearer priorities. These findings are encouraging, but they do not establish that every workplace will obtain the same results.',
      'An organisation considering a shorter week therefore needs to examine its own situation. It must decide how to maintain services, measure performance and distribute work fairly. The useful question is not only whether people can work fewer hours, but how that change can be made sustainable.',
    ],
    points: ['讨论的是减少总工时且不减薪，不只是把同样工时压缩到更少天。', '英国试验中许多员工报告压力减轻，多数参与企业想继续；不能据此保证所有企业有效。', '实施前要考虑服务、绩效和公平分工，重点是能否持续。'],
    references: [
      'Some employers are testing shorter hours without lower pay. In a British trial, many workers reported less stress and most participating firms wanted to continue. Success elsewhere still depends on a workable plan for services and fair workloads.',
      'The article distinguishes genuinely shorter hours from compressing the same hours into fewer days. In a British trial, many workers felt less stressed and most participating companies wished to continue. However, these findings cannot be applied automatically to every workplace. A lasting arrangement needs changes to how work is organised, reliable services, meaningful performance measures and a fair division of tasks.',
    ],
    pitfalls: ['不要把“试验中的员工报告压力降低”说成“所有人都会更高效”。', '减少总工时和压缩工作周不是同一件事；不减薪也不能漏掉。'],
    phrases: [{ text: 'keep pay unchanged', meaning: '保持薪资不变' }, { text: 'maintain services', meaning: '维持服务' }, { text: 'a fair division of tasks', meaning: '公平分工' }],
    sources: [{ title: 'Would you prefer a four-day working week?', publisher: 'University of Cambridge', url: 'https://www.cam.ac.uk/stories/fourdayweek' }, { title: 'Working Time and Work-Life Balance Around the World', publisher: 'International Labour Organization', url: 'https://www.ilo.org/publications/working-time-and-work-life-balance-around-world' }],
  },
  {
    id: 'cooler-cities', title: 'How trees help cool a city', chineseTitle: '树木怎样为城市降温', topic: '环境与城市', introduction: '树荫之外，植物还通过什么过程影响城市温度？',
    paragraphs: [
      'A city can remain warmer than its surroundings because roads and buildings absorb and retain heat. Trees help address this problem in two ways. Their branches and leaves provide shade, reducing the sunlight that reaches surfaces below. They also release water through their leaves, a process that helps cool the surrounding air.',
      'The effect is not identical everywhere. The local climate, the amount of vegetation and the water available to plants all influence how much cooling a green space can provide. Planting a tree is therefore a long-term decision, not an instant guarantee of a cooler street.',
      'Urban planners need to choose suitable plants, provide space for growth and arrange continuing care. They should also consider where shade is most needed. Green spaces can be part of a wider response to urban heat, alongside other measures. The goal is to improve everyday conditions through careful planning, rather than assume that one solution will work equally well in every neighbourhood.',
    ],
    points: ['道路和建筑吸收并保留热量；树木可通过遮阴和叶片释放水分帮助降温。', '降温效果受气候、植被数量和可用水分影响，不是到处相同。', '规划需要合适的植物、长期养护和恰当选址，绿地只是应对城市热的一部分。'],
    references: [
      'Trees can cool cities by shading hot surfaces and releasing water through their leaves. Their effect depends on local conditions, including climate and water availability. Cities need appropriate planting and long-term care, combined with other ways of reducing urban heat.',
      'Roads and buildings can trap heat, making cities warmer than nearby areas. Trees provide shade and help cool the air as water leaves their foliage. However, the benefit varies with climate, vegetation and available water. Effective urban planting requires suitable species, space, continuing maintenance and attention to where shade is needed. It forms one part of a broader response to urban heat.',
    ],
    pitfalls: ['“帮助局部降温”不等于“种树能单独解决全球变暖”。', '不要遗漏条件：并非所有城市或街区降温幅度都相同。'],
    phrases: [{ text: 'provide shade', meaning: '提供荫凉' }, { text: 'depend on local conditions', meaning: '取决于当地条件' }, { text: 'long-term care', meaning: '长期养护' }],
    sources: [{ title: 'Using Trees and Vegetation to Reduce Heat Islands', publisher: 'US EPA', url: 'https://www.epa.gov/heatislands/benefits-trees-and-vegetation' }, { title: 'NASA Data Reveals Role of Green Spaces in Cooling Cities', publisher: 'NASA', url: 'https://science.nasa.gov/earth/climate-change/nasa-data-reveals-role-of-green-spaces-in-cooling-cities/' }],
  },
  {
    id: 'revisiting-words', title: 'Give a new word another meeting', chineseTitle: '让新词在以后再次出现', topic: '学习与成长', introduction: '一口气反复看，与隔一段时间再回忆，有什么区别？',
    paragraphs: [
      'When a new word looks familiar, it is easy to assume that learning is complete. Yet recognising a word on a page is different from recalling its meaning later or using it in conversation. A useful study routine therefore gives the learner several opportunities to meet and retrieve the word.',
      'Research on second-language learning suggests that distributing practice over time can support retention. Looking again immediately may feel easier, while returning after a gap can require more effort. The best interval depends on the learning task and how long the information needs to be remembered; there is no single timetable that suits every situation.',
      'Vocabulary practice should also connect with communication. A learner can notice an expression in a short text, explain the main idea aloud, and use the expression in a new sentence. Reviewing words and using them serve related but different purposes. A balanced routine makes room for both, instead of treating a large daily word count as the only sign of progress.',
    ],
    points: ['看着眼熟不等于以后能回忆，也不等于会在交流中使用。', '把练习分散到不同时间有助于保持记忆，但没有适合所有任务的固定间隔。', '复习词汇还要配合阅读、口头解释和造句，刷词数不是唯一进步指标。'],
    references: [
      'Recognising a word does not mean that we can recall or use it later. Spacing practice over time can help retention, although the right interval varies. Learners also need to use vocabulary in meaningful reading, speaking and writing, rather than judge progress only by word counts.',
      'The article separates familiarity, recall and practical use. Repeated encounters and retrieval give a word more opportunities to be learned. Research supports spaced practice, but the interval should reflect the task and the retention goal. Deliberate vocabulary study should also connect with communication, such as explaining a text aloud or making a new sentence. Both review and meaningful use belong in a balanced routine.',
    ],
    pitfalls: ['不要把“间隔练习有帮助”说成“每天固定复习一次适合所有人和任务”。', '回忆、识别和实际表达是不同能力，不能只说背词越多越好。'],
    phrases: [{ text: 'recall its meaning', meaning: '回忆它的意思' }, { text: 'distribute practice over time', meaning: '把练习分散到不同时间' }, { text: 'make room for both', meaning: '为两者都留出时间或空间' }],
    sources: [{ title: 'The Effects of Spaced Practice on Second Language Learning: A Meta-Analysis', publisher: 'Language Learning', url: 'https://doi.org/10.1111/lang.12479' }, { title: 'The Four Strands', publisher: 'Paul Nation · Victoria University of Wellington', url: 'https://openaccess.wgtn.ac.nz/articles/journal_contribution/The_four_strands/12552167' }],
  },
  {
    id: 'small-plastic', title: 'When plastic becomes smaller', chineseTitle: '塑料变小，不等于消失', topic: '科学与环境', introduction: '海里的塑料碎成小颗粒后，问题就解决了吗？',
    paragraphs: [
      'A plastic bottle that breaks into tiny pieces has not necessarily disappeared from the environment. Sunlight, waves and other forces can fragment larger plastic objects. Pieces smaller than five millimetres are known as microplastics. Some small plastic particles also enter the environment directly, rather than first breaking off a larger item.',
      'Their small size makes them difficult to collect once they have spread through water. Finding less visible rubbish on a beach does not therefore prove that the plastic pollution has gone away. The fragments may remain, even when they are hard to see.',
      'Removing existing waste still matters, but preventing new material from entering waterways is also important. Better waste handling and changes in everyday behaviour can form part of that effort. The central distinction is between becoming smaller and fully breaking down. Understanding that difference helps explain why a clean-looking surface is not always evidence of a clean environment.',
    ],
    points: ['较大的塑料会碎裂，小于五毫米的塑料颗粒称为微塑料；部分颗粒也会直接进入环境。', '颗粒变小后难以收集，看不见垃圾不代表污染已经消失。', '既要清理现有垃圾，也要预防新的塑料进入水体；碎裂和完全分解不同。'],
    references: [
      'Plastic can break into microplastics without disappearing. These tiny pieces are difficult to remove, so a clean-looking beach does not prove that pollution is gone. Cleaning up waste and preventing more plastic from reaching waterways are both important.',
      'Microplastics are plastic pieces smaller than five millimetres. Some come from larger objects breaking apart, while others enter the environment as small particles. Because they are hard to collect, their reduced visibility should not be confused with complete breakdown. Addressing the problem involves removing existing waste and limiting new inputs. A surface that looks clean can still contain plastic fragments.',
    ],
    pitfalls: ['五毫米不是五厘米。语音识别可能听错数字或单位，需要回听确认。', '“碎成小颗粒”不能改写成“已经完全分解、没有污染”。'],
    phrases: [{ text: 'break into tiny pieces', meaning: '碎成小颗粒' }, { text: 'prevent new material from entering', meaning: '防止新物质进入' }, { text: 'be confused with', meaning: '与……混淆' }],
    sources: [{ title: 'What are microplastics?', publisher: 'NOAA', url: 'https://oceanservice.noaa.gov/education/tutorial-coastal/marine-debris/md04.html' }, { title: 'Plastic', publisher: 'NOAA Marine Debris Program', url: 'https://marinedebris.noaa.gov/what-marine-debris/plastic' }],
  },
]);
export function lessonWordCount(lesson: RetellLesson): number { return lesson.paragraphs.join(' ').match(/\b[A-Za-z]+(?:['’-][A-Za-z]+)*\b/g)?.length ?? 0; }

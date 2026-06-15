import { parseHumanIntent } from './intent-parser';
import type { ImageProfile } from '../vision-local';

export interface ConversationContext {
  history: Array<{ role: string; content: string }>;
}

export interface ConversationResult {
  content: string;
  suggestBuild: boolean;
  buildPrompt?: string;
  featureId?: string;
  tier: ResponseTier;
}

export type ResponseTier = 'instant' | 'fast' | 'normal' | 'deep';

export type Topic =
  | 'greeting' | 'farewell' | 'thanks' | 'casual' | 'emotional'
  | 'compliment' | 'joke' | 'build' | 'image' | 'followup'
  | 'science' | 'tech' | 'life' | 'health' | 'food' | 'travel'
  | 'money' | 'relationship' | 'work' | 'entertainment' | 'philosophy'
  | 'education' | 'opinion' | 'advice' | 'explain' | 'general';

function isBg(text: string) {
  return /[а-яА-ЯёЁ]/.test(text);
}

function lang(text: string, history: ConversationContext['history']) {
  const bg = isBg(text) || isBg(history.map((m) => m.content).join(''));
  return bg ? 'bg' : 'en';
}

function recentUser(history: ConversationContext['history'], n = 3) {
  return history.filter((m) => m.role === 'user').slice(-n).map((m) => m.content);
}

function classify(text: string, history: ConversationContext['history'], hasImage: boolean): Topic {
  const lower = text.toLowerCase().trim();
  const all = `${recentUser(history).join(' ')} ${lower}`;

  if (hasImage) {
    if (!text || /снимк|виждаш|опиши|какво е|what is this|image/i.test(lower)) return 'image';
    if (/код|build|генерирай|направи|zip|давай/i.test(lower)) return 'build';
  }
  if (/^(здрав|здрасти|здравей|hello|hi|hey|привет|добро утро|добър вечер|добър ден|good morning|good evening|йо|yo|супер|cool|nice)/i.test(lower)) return 'greeting';
  if (/^(довиждане|чао|bye|goodbye|see you|лека нощ|good night|ciao)$/i.test(lower)) return 'farewell';
  if (/^(благодар|thanks|thank you|merci|thx|мерси)$/i.test(lower)) return 'thanks';
  if (/^(как си|как я|как е|how are you|how r u|how's it going|what's up|какво става|как върви|кво става)$/i.test(lower)) return 'casual';
  if (/^(хаха|ха ха|лол|lol|хехе|hehe|😄|😂|🤣)$/i.test(lower)) return 'joke';
  if (/^(добре|добре съм|fine|good|great|супер|чудесно).*(ти|you|а ти)|^(а ти|ти как|and you|you\?)|какво правиш|кво правиш|what are you doing|what r u doing/i.test(lower)) return 'casual';
  if (/скуча|съм тъжен|тъга|alone|сам съм|emo/i.test(lower)) return 'emotional';
  if (/щастлив|любов|обичам|мразя|страх|тревож/i.test(all)) return 'emotional';
  if (/харесваш|обичаш ли|who are you|кой си|какво си|compliment|красив/i.test(lower)) return 'compliment';
  if (/шега|виц|joke|funny|смеш/i.test(lower)) return 'joke';

  if (/направи|създай|build|генерирай|искам (сайт|ап|проект)|zip|screenshot.*код/i.test(lower)) return 'build';

  if (/космос|вселен|планет|физик|химия|биолог|наук|science|атом|dna/i.test(lower)) return 'science';
  if (/react|next\.js|програмиран|software|компютър|изкуствен интелект/i.test(lower)) return 'tech';
  if (/код|api|bug|deploy/i.test(lower) && /как|какво|генерирай|build/i.test(lower)) return 'tech';
  if (/любов|връзк|партньор|раздял|relationship|dating|брак/i.test(lower)) return 'relationship';
  if (/работа|кариера|колега|шеф|job|career|уволн/i.test(lower)) return 'work';
  if (/пари|заплат|инвест|бюджет|money|finance|кредит/i.test(lower)) return 'money';
  if (/готв|рецепт|храна|food|cook|диет/i.test(lower)) return 'food';
  if (/пътув|почивк|travel|държав|град|ваканц/i.test(lower)) return 'travel';
  if (/здраве|здравослов|болен|болест|симптом|health|лекар|сон|спорт|фитнес/i.test(lower)) return 'health';
  if (/филм|сериал|музик|книг|игра|movie|music|book|netflix/i.test(lower)) return 'entertainment';
  if (/смисъл|философ|happiness|щастие|meaning/i.test(lower)) return 'philosophy';
  if (/учен|училищ|университет|изпит|school|learn|study/i.test(lower)) return 'education';

  if (/какво мислиш|мнение|opinion|според теб|what do you think/i.test(lower)) return 'opinion';
  if (/съвет|препоръч|advice|какво да правя|what should i/i.test(lower)) return 'advice';
  if (/какво е|what is|как работи|how does|обясни|explain|защо|why/i.test(lower)) return 'explain';

  if (history.length > 1 && text.length < 80 && /^(а |и |ок|да|не|още|а какво|what about)/i.test(lower)) return 'followup';

  return 'general';
}

function pickFeature(text: string, hasImage: boolean): string {
  const lower = text.toLowerCase();
  if (hasImage) return /mobile|мобил/i.test(lower) ? 'screenshot-mobile' : 'screenshot-website';
  if (/api|backend/i.test(lower)) return 'api-gen';
  if (/database|база/i.test(lower)) return 'db-gen';
  return 'prompt-software';
}

// ─── Casual & social ───────────────────────────────────────────────

function greeting(l: string) {
  const hour = new Date().getHours();
  if (l === 'bg') {
    if (hour < 12) return 'Добро утро! ☀️ Радвам се, че пишеш. Как се чувстваш днес?';
    if (hour < 18) return 'Здравей! Добър ден ти желая. Как върви?';
    return 'Здравей! Добър вечер. Приятно ми е да си говорим — как си?';
  }
  if (hour < 12) return 'Good morning! Lovely to hear from you. How are you feeling today?';
  if (hour < 18) return 'Hello! Hope your day is going well. How are you?';
  return 'Good evening! Nice to chat with you — how are you doing?';
}

function casual(text: string, l: string) {
  if (/какво правиш|кво правиш|what are you doing/i.test(text)) {
    return l === 'bg'
      ? 'В момента си говоря с теб! 😊 Готов съм за чат, идеи или код — какво те интересува?'
      : "Talking with you right now! 😊 Ready to chat, brainstorm, or code — what's up?";
  }
  if (/добре|fine|good|great|супер|чудесно/i.test(text) && /ти|you|а ти/i.test(text)) {
    return l === 'bg'
      ? 'И аз съм добре, мерси! 😊 Радвам се. Какво правиш днес?'
      : "I'm good too, thanks! 😊 Glad to hear it. What are you up to today?";
  }
  const variants = l === 'bg'
    ? [
        'Добре съм! 😊 А ти как си?',
        'Чудесно, мерси! Как върви при теб?',
        'Добре съм — готов за чат. Какво те занимава?',
      ]
    : [
        "I'm good, thanks! 😊 How about you?",
        "Doing great! What's on your mind?",
        "All good — happy to chat. How are you?",
      ];
  return variants[Math.floor(Date.now() / 30000) % variants.length];
}

function tierForTopic(topic: Topic, text: string): ResponseTier {
  if (['greeting', 'farewell', 'thanks', 'casual', 'joke', 'compliment'].includes(topic)) return 'instant';
  if (topic === 'followup' || topic === 'emotional') return text.length < 60 ? 'fast' : 'normal';
  if (['build', 'image', 'science', 'philosophy'].includes(topic)) return 'deep';
  if (['explain', 'advice', 'tech'].includes(topic) && text.length > 120) return 'deep';
  if (topic === 'general' && text.length < 20) return 'instant';
  return 'normal';
}

function farewell(l: string) {
  return l === 'bg'
    ? 'Довиждане! Беше ми приятно. Пиши когато искаш — винаги съм тук. 💙'
    : 'Goodbye! It was nice talking. Write anytime — I\'m always here. 💙';
}

function thanks(l: string) {
  return l === 'bg'
    ? 'Много мило! С удоволствие помагам. Има ли още нещо, за което да поговорим?'
    : 'You\'re very welcome! Happy to help. Anything else on your mind?';
}

function emotional(text: string, l: string) {
  if (/тъжен|тъга|sad|alone|сам/i.test(text)) {
    return l === 'bg'
      ? 'Чувам те и съжалявам, че ти е трудно. Това, което чувстваш, е валидно. Понякога просто да го кажеш на някого помага. Ако искаш — разкажи повече, без да те прекъсвам. А при сериозна криза — потърси близък човек или специалист.'
      : 'I hear you, and I\'m sorry you\'re going through this. What you feel is valid. Sometimes saying it out loud helps. If you want, tell me more. For serious crises, please reach out to someone you trust or a professional.';
  }
  if (/щастлив|happy|радост/i.test(text)) {
    return l === 'bg'
      ? 'Това е прекрасно! 🎉 Радвам се за теб. Разкажи — какво те прави щастлив/а в момента?'
      : 'That\'s wonderful! 🎉 I\'m happy for you. What\'s making you feel good right now?';
  }
  return l === 'bg'
    ? 'Емоциите са важна част от живота. Разкажи ми повече — слушам те внимателно.'
    : 'Emotions matter. Tell me more — I\'m listening carefully.';
}

function compliment(l: string) {
  return l === 'bg'
    ? 'Аз съм Supreme Brain — интелигентен асистент в SharkAI. Обичам добрите разговори, независимо дали са за ежедневие, идеи, наука или просто „как си". Радвам се, че си тук! 🦈'
    : 'I\'m Supreme Brain — an intelligent assistant in SharkAI. I enjoy good conversation on anything: daily life, ideas, science, or just "how are you." Glad you\'re here! 🦈';
}

function joke(l: string) {
  return l === 'bg'
    ? 'Защо програмистите бъркат Хелоуин с Коледа? Защото Oct 31 == Dec 25. 😄\n\nНо сериозно — какво те весели в момента?'
    : 'Why do programmers confuse Halloween with Christmas? Because Oct 31 == Dec 25. 😄\n\nBut seriously — what\'s making you smile today?';
}

// ─── Universal knowledge topics ────────────────────────────────────

function science(text: string, l: string) {
  if (/космос|вселен|space|universe/i.test(text)) {
    return l === 'bg'
      ? 'Вселената е на около 13.8 млрд. години — наблюдаемата част съдържа над 2 трилиона галактики. Земята е крошка в Млечния път, а светлината от най-далечните обекти пътува милиарди години до нас. Космосът учи на смирение и любопитство.'
      : 'The universe is ~13.8 billion years old with 2+ trillion galaxies. Earth is a speck in the Milky Way. Space teaches humility and curiosity.';
  }
  return l === 'bg'
    ? 'Наука е систематичният начин да разбираме света — хипотеза, експеримент, закон. Питай за конкретна област (физика, биология, космос) и ще навляза по-дълбоко.'
    : 'Science is how we systematically understand the world. Ask about a specific field and I\'ll go deeper.';
}

function tech(text: string, l: string) {
  if (/sharkai|шарк/i.test(text)) {
    return l === 'bg'
      ? 'SharkAI е платформа с Supreme Brain + 15 агента за генериране на код, screenshot → проект, и отворен чат. Работи локално и безплатно.'
      : 'SharkAI is a platform with Supreme Brain + 15 agents for code generation and open chat. Runs locally and free.';
  }
  return l === 'bg'
    ? 'Технологиите променят живота ни всеки ден — от AI до смартфони. Каква конкретна тема те интересува? Мога да обясня, сравня, или ако искаш — да генерирам код в Studio.'
    : 'Technology shapes our lives daily. What specific topic interests you? I can explain, compare, or generate code in Studio if you want.';
}

function relationship(text: string, l: string) {
  return l === 'bg'
    ? 'Отношенията изискват комуникация, доверие и време. Няма перфектна формула, но активното слушане и честност са основа. Разкажи ситуацията — ще ти дам конкретни мисли, без да те съдя.'
    : 'Relationships need communication, trust, and time. Active listening and honesty are key. Tell me the situation — I\'ll share thoughts without judging.';
}

function work(text: string, l: string) {
  return l === 'bg'
    ? 'Работата заема голяма част от живота — важно е да има баланс. Ако си под стрес: приоритизирай, делегирай, прави паузи. Ако търсиш кариера: умения + мрежа + постоянство. Какъв е твоят случай?'
    : 'Work takes a big part of life — balance matters. Under stress: prioritize, delegate, rest. Career growth: skills + network + consistency. What\'s your situation?';
}

function money(text: string, l: string) {
  return l === 'bg'
    ? 'Финансова грамотност: живей под средствата си, спестявай поне 10–20%, избягвай високи лихви по дълг, инвестирай дългосрочно в индексни фондове ако имаш хоризонт. Не съм финансов съветник — за големи решения говори с експерт.'
    : 'Basics: live below means, save 10–20%, avoid high-interest debt, long-term index investing if you have horizon. Not financial advice — consult experts for big decisions.';
}

function food(text: string, l: string) {
  return l === 'bg'
    ? 'Храната е удоволствие и култура! Общи съвети: разнообразие, повече зеленчуци, по-малко преработени продукти, готви с удоволствие. Имаш ли конкретна кухня или рецепта наум?'
    : 'Food is pleasure and culture! Variety, more vegetables, less processed food, cook with joy. Any specific cuisine or recipe in mind?';
}

function travel(text: string, l: string) {
  return l === 'bg'
    ? 'Пътуването разширява хоризонтите — нови хора, култури, гледни точки. Планирай бюджет, резервирай рано, учи няколко фрази на местния език, бъди отворен/а. Къде мечтаеш да отидеш?'
    : 'Travel broadens horizons. Plan budget, book early, learn local phrases, stay open-minded. Where do you dream of going?';
}

function health(text: string, l: string) {
  return l === 'bg'
    ? 'За общо здраве: движение 30 мин дневно, 7–8 ч сън, вода, балансирана храна, социални контакти, намаляване на стреса. ⚠️ Не съм лекар — при симптоми или болка потърси специалист.'
    : 'General wellness: 30 min movement, 7–8h sleep, water, balanced diet, social connection, stress management. ⚠️ Not a doctor — see a professional for symptoms.';
}

function entertainment(text: string, l: string) {
  return l === 'bg'
    ? 'Изкуството и забавлението ни зареждат — филми, музика, книги, игри. Какво предпочиташ в момента — нещо леко, вдъхновяващо, или екшън? Мога да предложя идеи по жанр.'
    : 'Art and entertainment recharge us. What mood — light, inspiring, or action? I can suggest ideas by genre.';
}

function philosophy(text: string, l: string) {
  return l === 'bg'
    ? 'Философията пита големите въпроси: какво е щастие, какъв е смисълът, как да живеем добре. Стоиците казват: фокус върху това, което контролираш. Екзистенциалистите — създавай смисъл сам/а. Какъв въпрос те занимава?'
    : 'Philosophy asks big questions: happiness, meaning, how to live well. Stoics: focus on what you control. Existentialists: create your own meaning. What question weighs on you?';
}

function education(text: string, l: string) {
  return l === 'bg'
    ? 'Ученето е цял живот. Ефективни методи: активно повторение, разбиване на малки части, практика вместо само четене, сън след учене. За какво учиш в момента?'
    : 'Learning is lifelong. Effective: active recall, small chunks, practice over passive reading, sleep after studying. What are you learning now?';
}

function explain(text: string, l: string) {
  const snippet = text.slice(0, 120);
  return l === 'bg'
    ? `Добър въпрос: „${snippet}".\n\nОбщо казано — нещата имат контекст и нюанси. Опитвам се да обясня ясно и честно. Ако уточниш какво точно те интересува (примери, сравнение, стъпки), ще отговоря по-конкретно.`
    : `Good question: "${snippet}".\n\nThings have context and nuance. I'll explain clearly and honestly. Specify if you want examples, comparison, or steps for a more concrete answer.`;
}

function opinion(text: string, l: string) {
  return l === 'bg'
    ? `По „${text.slice(0, 80)}": няма еднозначен отговор — зависи от перспектива, опит и ценности. Бих казал, че е важно да чуеш различни гледни точки, да мислиш критично, и да решаваш според твоите приоритети. Какво мислиш ти?`
    : `On "${text.slice(0, 80)}": no single answer — depends on perspective and values. Hear different views, think critically, decide by your priorities. What do you think?`;
}

function advice(text: string, l: string) {
  return l === 'bg'
    ? `За „${text.slice(0, 80)}":\n\n1. Спри и изясни какво искаш да постигнеш\n2. Виж плюсовете и минусите на всяка опция\n3. Говори с някой, на когото имаш доверие\n4. Действай с малка стъпка — не чакай перфектния момент\n\nРазкажи повече за ситуацията, ако искаш по-точен съвет.`
    : `For "${text.slice(0, 80)}":\n\n1. Clarify what you want\n2. Weigh pros and cons\n3. Talk to someone you trust\n4. Take a small step — don't wait for perfect\n\nTell me more for tailored advice.`;
}

function followup(text: string, history: ConversationContext['history'], l: string) {
  const prev = recentUser(history, 1)[0] || '';
  return l === 'bg'
    ? `Да, в контекста на „${prev.slice(0, 50)}…" — ${text}\n\nПродължавам: разкажи още и ще отговоря по-конкретно.`
    : `Yes, following "${prev.slice(0, 50)}…" — ${text}\n\nGo on, tell me more for a specific answer.`;
}

function general(text: string, l: string) {
  const snippet = text.length > 180 ? text.slice(0, 180) + '…' : text;

  if (text.length < 15 && /^(да|не|ок|hmm|аха|yea|yep|nope)$/i.test(text)) {
    return l === 'bg' ? 'Разбрах. Продължавай — слушам те.' : 'Got it. Go on — I\'m listening.';
  }

  if (/\?/.test(text) || /^(какво|как|защо|къде|кога|кой|колко|what|how|why|where|when|who)/i.test(text)) {
    return l === 'bg'
      ? `Интересен въпрос: „${snippet}"\n\nОпитвам се да отговоря честно и смислено. Всяка тема има нюанси — ако искаш, задълбочаваме с примери или стъпки.`
      : `Interesting question: "${snippet}"\n\nI'll answer honestly and thoughtfully. Every topic has nuance — we can go deeper with examples if you want.`;
  }

  return l === 'bg'
    ? `Чувам те: „${snippet}"\n\nРазказвай свободно — мога да говоря за всичко: ежедневие, идеи, чувства, наука, работа, хобита, технологии. Какво те интересува повече по тази тема?`
    : `I hear you: "${snippet}"\n\nTalk freely — I can discuss anything: daily life, ideas, feelings, science, work, hobbies, tech. What interests you most about this?`;
}

function imageReply(text: string, profile: ImageProfile | null | undefined, l: string): ConversationResult {
  if (profile) {
    const c = profile.colors.slice(0, 3).join(', ');
    const info = l === 'bg'
      ? `Виждам снимка (${profile.width}×${profile.height}, ${profile.isDark ? 'тъмна' : 'светла'}, цветове: ${c}).`
      : `I see an image (${profile.width}×${profile.height}, colors: ${c}).`;
    if (!text) {
      return {
        content: `${info}\n\n${l === 'bg' ? 'Опиши, коментирай, или кажи „давай" за код + ZIP.' : 'Describe, comment, or say "go" for code + ZIP.'}`,
        suggestBuild: false,
        tier: 'deep',
      };
    }
    return {
      content: `${info}\n\n${l === 'bg' ? `По „${text}" — мога да коментирам или да генерирам проект.` : `Re: "${text}" — I can comment or generate a project.`}`,
      suggestBuild: /код|генерирай|build|zip|направи/i.test(text),
      buildPrompt: text,
      featureId: pickFeature(text, true),
      tier: 'deep',
    };
  }
  return {
    content: l === 'bg' ? 'Виждам снимката. Какво правим с нея?' : 'I see the image. What should we do?',
    suggestBuild: false,
    tier: 'fast',
  };
}

function buildReply(text: string, l: string): ConversationResult {
  const intent = parseHumanIntent(text, 'website');
  return {
    content: l === 'bg'
      ? `${intent.understanding}\n\nКажи „давай" за код + ZIP, или продължаваме да обсъждаме.`
      : `${intent.understanding}\n\nSay "go" for code + ZIP, or keep discussing.`,
    suggestBuild: /давай|започни|генерирай|build now|go|zip/i.test(text),
    buildPrompt: text,
    featureId: pickFeature(text, false),
    tier: 'deep',
  };
}

// ─── Main entry ──────────────────────────────────────────────────────

export function supremeConversation(
  message: string,
  context: ConversationContext,
  hasImage?: boolean,
  imageProfile?: ImageProfile | null
): ConversationResult {
  const text = message.trim();
  const l = lang(text, context.history);
  const imageRelevant = !!hasImage && (!text || /снимк|виждаш|опиши|код|build|генерирай|направи|zip|давай/i.test(text.toLowerCase()));
  const topic = classify(text, context.history, imageRelevant);

  if (topic === 'image') return imageReply(text, imageProfile, l);
  if (topic === 'build') return buildReply(text, l);

  const content = (() => {
    switch (topic) {
      case 'greeting': return greeting(l);
      case 'farewell': return farewell(l);
      case 'thanks': return thanks(l);
      case 'casual': return casual(text, l);
      case 'emotional': return emotional(text, l);
      case 'compliment': return compliment(l);
      case 'joke': return joke(l);
      case 'science': return science(text, l);
      case 'tech': return tech(text, l);
      case 'relationship': return relationship(text, l);
      case 'work': return work(text, l);
      case 'money': return money(text, l);
      case 'food': return food(text, l);
      case 'travel': return travel(text, l);
      case 'health': return health(text, l);
      case 'entertainment': return entertainment(text, l);
      case 'philosophy': return philosophy(text, l);
      case 'education': return education(text, l);
      case 'explain': return explain(text, l);
      case 'opinion': return opinion(text, l);
      case 'advice': return advice(text, l);
      case 'followup': return followup(text, context.history, l);
      default: return general(text, l);
    }
  })();

  return { content, suggestBuild: false, tier: tierForTopic(topic, text) };
}

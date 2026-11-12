/**
 * The palette's view of the AI prompt templates (./multiLangPrompts.ts): id,
 * label, language and category, without the prompts. The command list is
 * built at startup; the prompts load with the command (multiLangPromptIndex.test
 * keeps the two in step).
 */
import type { AiPromptTemplate } from "./multiLangPrompts";

export type AiPromptEntry = Omit<AiPromptTemplate, "prompt">;

// [id, label, language, category]: tuples, as the list ships in the startup bundle.
const ROWS: Array<[string, string, string, AiPromptEntry["category"]]> = [
  ["he.summarize", "📝 סיכום בעברית", "he", "writing"],
  ["he.improve", "✨ שיפור כתיבה בעברית", "he", "editing"],
  ["he.translate_to_en", "🌐 תרגום עברית → אנגלית", "he", "translation"],
  ["he.formal", "📄 המרה לשפה רשמית", "he", "editing"],
  ["he.explain", "🎓 הסבר פשוט בעברית", "he", "analysis"],
  ["ar.summarize", "📝 تلخيص بالعربية", "ar", "writing"],
  ["ar.improve", "✨ تحسين الكتابة بالعربية", "ar", "editing"],
  ["ar.translate_to_en", "🌐 ترجمة عربي → إنجليزي", "ar", "translation"],
  ["ru.summarize", "📝 Резюме на русском", "ru", "writing"],
  ["ru.improve", "✨ Улучшение текста", "ru", "editing"],
  ["ru.translate_to_en", "🌐 Перевод рус → англ", "ru", "translation"],
  ["en.summarize", "📝 Summarize in English", "en", "writing"],
  ["en.improve", "✨ Improve Writing", "en", "editing"],
  ["en.simplify", "🎓 Simplify / ELI5", "en", "analysis"],
  ["en.code_review", "🔍 Code Review", "en", "code"],
  ["en.blog_post", "📰 Blog Post Draft", "en", "writing"],
  ["en.translate_to_he", "🌐 English → Hebrew", "en", "translation"],
  ["es.summarize", "📝 Resumen en español", "es", "writing"],
  ["es.improve", "✨ Mejorar redacción", "es", "editing"],
  ["fr.summarize", "📝 Résumé en français", "fr", "writing"],
  ["fr.improve", "✨ Améliorer la rédaction", "fr", "editing"],
  ["de.summarize", "📝 Zusammenfassung auf Deutsch", "de", "writing"],
  ["de.improve", "✨ Text verbessern", "de", "editing"],
  ["pt.summarize", "📝 Resumo em português", "pt", "writing"],
  ["pt.improve", "✨ Melhorar a escrita", "pt", "editing"],
  ["it.summarize", "📝 Riassunto in italiano", "it", "writing"],
  ["it.improve", "✨ Migliorare la scrittura", "it", "editing"],
  ["zh.summarize", "📝 中文摘要", "zh", "writing"],
  ["zh.improve", "✨ 改进写作", "zh", "editing"],
  ["ja.summarize", "📝 日本語で要約", "ja", "writing"],
  ["ja.improve", "✨ 文章を改善", "ja", "editing"],
  ["ko.summarize", "📝 한국어 요약", "ko", "writing"],
  ["ko.improve", "✨ 글쓰기 개선", "ko", "editing"],
];

export const AI_PROMPT_INDEX: AiPromptEntry[] = ROWS.map(([id, label, lang, category]) => ({ id, label, lang, category }));

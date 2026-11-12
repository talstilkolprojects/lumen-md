/**
 * The palette's view of the AI prompt templates (./multiLangPrompts.ts): id,
 * label, language and category, without the prompts. The command list is
 * built at startup; the prompts load with the command (multiLangPromptIndex.test
 * keeps the two in step).
 */
import type { AiPromptTemplate } from "./multiLangPrompts";

export type AiPromptEntry = Omit<AiPromptTemplate, "prompt">;

export const AI_PROMPT_INDEX: AiPromptEntry[] = [
  { id: "he.summarize", label: "📝 סיכום בעברית", lang: "he", category: "writing" },
  { id: "he.improve", label: "✨ שיפור כתיבה בעברית", lang: "he", category: "editing" },
  { id: "he.translate_to_en", label: "🌐 תרגום עברית → אנגלית", lang: "he", category: "translation" },
  { id: "he.formal", label: "📄 המרה לשפה רשמית", lang: "he", category: "editing" },
  { id: "he.explain", label: "🎓 הסבר פשוט בעברית", lang: "he", category: "analysis" },
  { id: "ar.summarize", label: "📝 تلخيص بالعربية", lang: "ar", category: "writing" },
  { id: "ar.improve", label: "✨ تحسين الكتابة بالعربية", lang: "ar", category: "editing" },
  { id: "ar.translate_to_en", label: "🌐 ترجمة عربي → إنجليزي", lang: "ar", category: "translation" },
  { id: "ru.summarize", label: "📝 Резюме на русском", lang: "ru", category: "writing" },
  { id: "ru.improve", label: "✨ Улучшение текста", lang: "ru", category: "editing" },
  { id: "ru.translate_to_en", label: "🌐 Перевод рус → англ", lang: "ru", category: "translation" },
  { id: "en.summarize", label: "📝 Summarize in English", lang: "en", category: "writing" },
  { id: "en.improve", label: "✨ Improve Writing", lang: "en", category: "editing" },
  { id: "en.simplify", label: "🎓 Simplify / ELI5", lang: "en", category: "analysis" },
  { id: "en.code_review", label: "🔍 Code Review", lang: "en", category: "code" },
  { id: "en.blog_post", label: "📰 Blog Post Draft", lang: "en", category: "writing" },
  { id: "en.translate_to_he", label: "🌐 English → Hebrew", lang: "en", category: "translation" },
  { id: "es.summarize", label: "📝 Resumen en español", lang: "es", category: "writing" },
  { id: "es.improve", label: "✨ Mejorar redacción", lang: "es", category: "editing" },
  { id: "fr.summarize", label: "📝 Résumé en français", lang: "fr", category: "writing" },
  { id: "fr.improve", label: "✨ Améliorer la rédaction", lang: "fr", category: "editing" },
  { id: "de.summarize", label: "📝 Zusammenfassung auf Deutsch", lang: "de", category: "writing" },
  { id: "de.improve", label: "✨ Text verbessern", lang: "de", category: "editing" },
  { id: "pt.summarize", label: "📝 Resumo em português", lang: "pt", category: "writing" },
  { id: "pt.improve", label: "✨ Melhorar a escrita", lang: "pt", category: "editing" },
  { id: "it.summarize", label: "📝 Riassunto in italiano", lang: "it", category: "writing" },
  { id: "it.improve", label: "✨ Migliorare la scrittura", lang: "it", category: "editing" },
  { id: "zh.summarize", label: "📝 中文摘要", lang: "zh", category: "writing" },
  { id: "zh.improve", label: "✨ 改进写作", lang: "zh", category: "editing" },
  { id: "ja.summarize", label: "📝 日本語で要約", lang: "ja", category: "writing" },
  { id: "ja.improve", label: "✨ 文章を改善", lang: "ja", category: "editing" },
  { id: "ko.summarize", label: "📝 한국어 요약", lang: "ko", category: "writing" },
  { id: "ko.improve", label: "✨ 글쓰기 개선", lang: "ko", category: "editing" },
];

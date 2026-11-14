/**
 * citations: bibliographic records of well-known public-domain works and
 * classic papers (bibliographic facts; this compilation is CC0 1.0). Titles
 * are given as published (`title`) and in APA sentence case (`titleSentence`,
 * proper nouns kept). The builder formats the expected APA 7 reference and a
 * BibTeX entry from these fields (scripts/golden/sets/small.mjs, formatApa /
 * formatBibtex), so the expected strings follow one written-down rule set.
 */
export const RECORDS = [
  { type: "book", authors: [["Melville", "Herman"]], year: 1851, title: "Moby-Dick; or, The Whale", titleSentence: "Moby-Dick; or, The whale", publisher: "Harper & Brothers" },
  { type: "book", authors: [["Austen", "Jane"]], year: 1813, title: "Pride and Prejudice", titleSentence: "Pride and prejudice", publisher: "T. Egerton" },
  { type: "book", authors: [["Darwin", "Charles"]], year: 1859, title: "On the Origin of Species by Means of Natural Selection", titleSentence: "On the origin of species by means of natural selection", publisher: "John Murray" },
  { type: "book", authors: [["Shelley", "Mary Wollstonecraft"]], year: 1818, title: "Frankenstein; or, The Modern Prometheus", titleSentence: "Frankenstein; or, The modern Prometheus", publisher: "Lackington, Hughes, Harding, Mavor & Jones" },
  { type: "book", authors: [["Dickens", "Charles"]], year: 1859, title: "A Tale of Two Cities", titleSentence: "A tale of two cities", publisher: "Chapman & Hall" },
  { type: "book", authors: [["Twain", "Mark"]], year: 1884, title: "Adventures of Huckleberry Finn", titleSentence: "Adventures of Huckleberry Finn", publisher: "Chatto & Windus" },
  { type: "book", authors: [["Thoreau", "Henry David"]], year: 1854, title: "Walden; or, Life in the Woods", titleSentence: "Walden; or, Life in the woods", publisher: "Ticknor and Fields" },
  { type: "book", authors: [["Hawthorne", "Nathaniel"]], year: 1850, title: "The Scarlet Letter", titleSentence: "The scarlet letter", publisher: "Ticknor, Reed & Fields" },
  { type: "book", authors: [["Stoker", "Bram"]], year: 1897, title: "Dracula", titleSentence: "Dracula", publisher: "Archibald Constable and Company" },
  { type: "book", authors: [["Wells", "H. G."]], year: 1895, title: "The Time Machine", titleSentence: "The time machine", publisher: "William Heinemann" },
  { type: "book", authors: [["Carroll", "Lewis"]], year: 1865, title: "Alice's Adventures in Wonderland", titleSentence: "Alice's adventures in Wonderland", publisher: "Macmillan" },
  { type: "book", authors: [["Brontë", "Charlotte"]], year: 1847, title: "Jane Eyre", titleSentence: "Jane Eyre", publisher: "Smith, Elder & Co." },
  { type: "book", authors: [["Wilde", "Oscar"]], year: 1891, title: "The Picture of Dorian Gray", titleSentence: "The picture of Dorian Gray", publisher: "Ward, Lock and Company" },
  { type: "book", authors: [["Stevenson", "Robert Louis"]], year: 1883, title: "Treasure Island", titleSentence: "Treasure island", publisher: "Cassell and Company" },
  { type: "book", authors: [["Eliot", "George"]], year: 1871, title: "Middlemarch", titleSentence: "Middlemarch", publisher: "William Blackwood and Sons" },
  { type: "article", authors: [["Einstein", "Albert"]], year: 1905, title: "Zur Elektrodynamik bewegter Körper", titleSentence: "Zur Elektrodynamik bewegter Körper", journal: "Annalen der Physik", volume: "17", issue: "10", pages: "891–921", doi: "10.1002/andp.19053221004" },
  { type: "article", authors: [["Mendel", "Gregor"]], year: 1866, title: "Versuche über Pflanzen-Hybriden", titleSentence: "Versuche über Pflanzen-Hybriden", journal: "Verhandlungen des naturforschenden Vereines in Brünn", volume: "4", pages: "3–47" },
  { type: "article", authors: [["Turing", "Alan M."]], year: 1936, title: "On Computable Numbers, with an Application to the Entscheidungsproblem", titleSentence: "On computable numbers, with an application to the Entscheidungsproblem", journal: "Proceedings of the London Mathematical Society", volume: "s2-42", issue: "1", pages: "230–265", doi: "10.1112/plms/s2-42.1.230" },
  { type: "article", authors: [["Shannon", "Claude E."]], year: 1948, title: "A Mathematical Theory of Communication", titleSentence: "A mathematical theory of communication", journal: "Bell System Technical Journal", volume: "27", issue: "3", pages: "379–423", doi: "10.1002/j.1538-7305.1948.tb01338.x" },
  { type: "article", authors: [["Watson", "James D."], ["Crick", "Francis H. C."]], year: 1953, title: "Molecular Structure of Nucleic Acids: A Structure for Deoxyribose Nucleic Acid", titleSentence: "Molecular structure of nucleic acids: A structure for deoxyribose nucleic acid", journal: "Nature", volume: "171", issue: "4356", pages: "737–738", doi: "10.1038/171737a0" },
  { type: "book", authors: [["Shannon", "Claude E."], ["Weaver", "Warren"]], year: 1949, title: "The Mathematical Theory of Communication", titleSentence: "The mathematical theory of communication", publisher: "University of Illinois Press" },
  { type: "book", authors: [["Marx", "Karl"], ["Engels", "Friedrich"]], year: 1848, title: "Manifest der Kommunistischen Partei", titleSentence: "Manifest der Kommunistischen Partei", publisher: "J. E. Burghard" },
  { type: "book", authors: [["Newton", "Isaac"]], year: 1687, title: "Philosophiæ Naturalis Principia Mathematica", titleSentence: "Philosophiæ naturalis principia mathematica", publisher: "Joseph Streater" },
];

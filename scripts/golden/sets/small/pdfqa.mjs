/**
 * pdf-qa: questions written for this set (CC0 1.0) about three
 * public-domain documents: John Adams's 1800 and Herbert Hoover's 1932
 * State of the Union addresses (works of the U.S. Government) and chapter 1
 * of Herman Melville's Moby-Dick (1851); the text comes from
 * @stdlib/datasets-sotu and @stdlib/datasets-moby-dick. Every answer is a
 * span of its document (the builder checks it occurs verbatim); `alt` lists
 * other acceptable answers.
 */
export const PDF_DOCS = [
  { id: "adams-1800", pkg: "sotu", file: "data/1800_john_adams_f.txt", title: "John Adams — Fourth Annual Message (1800)" },
  { id: "hoover-1932", pkg: "sotu", file: "data/1932_herbert_hoover_r.txt", title: "Herbert Hoover — Fourth Annual Message (1932)" },
  { id: "moby-dick-ch1", pkg: "moby", file: "data/chapter_1.txt", title: "Herman Melville — Moby-Dick, Chapter 1: Loomings (1851)" },
];

export const PDF_QUESTIONS = [
  ["adams-1800", "In which city did Congress hold its previous session?", "Philadelphia"],
  ["adams-1800", "With which king has a treaty of amity and commerce been concluded?", "the King of Prussia", ["Prussia"]],
  ["adams-1800", "Which article of the treaty with Great Britain has had its execution suspended?", "the 6th article", ["6th article", "sixth article"]],
  ["adams-1800", "Who received the American envoys in France?", "the First Consul", ["First Consul"]],
  ["adams-1800", "How many persons were appointed in France to treat with the American envoys?", "3", ["three"]],
  ["adams-1800", "Over which territory does Adams ask Congress to consider exercising its local powers?", "the District of Columbia", ["District of Columbia"]],
  ["adams-1800", "What happened to the officers and soldiers of the temporary army?", "discharged", ["they were discharged"]],
  ["adams-1800", "Which system does Adams once more recommend to Congress's serious consideration?", "the judiciary system of the United States", ["judiciary system"]],
  ["adams-1800", "Besides a navy, what should be contemplated for the principal sea ports and harbors?", "fortification", ["fortifications"]],
  ["adams-1800", "Which manufacture does Adams say still invites the attention of the National Legislature?", "The manufacture of arms", ["arms"]],
  ["hoover-1932", "What does Hoover say first about the country's relations?", "Our country is at peace.", ["at peace"]],
  ["hoover-1932", "Who furnished the information on the state of public health?", "The Surgeon General", ["Surgeon General"]],
  ["hoover-1932", "What was the infant mortality rate per 1,000 in 1932, by the table?", "55.0"],
  ["hoover-1932", "What was the general mortality rate per 1,000 in 1928, by the table?", "11.9"],
  ["hoover-1932", "Which corporation's loans to States that exhausted their resources guarantee there should be no hunger?", "the Reconstruction Finance Corporation", ["Reconstruction Finance Corporation"]],
  ["hoover-1932", "Due to what did the situation develop into a series of most acute crises?", "the European collapse", ["European collapse"]],
  ["hoover-1932", "In which month did the emergency measures begin to show their weight toward improvement?", "July"],
  ["hoover-1932", "What was the industrial production index in December 1931, by the table?", "74"],
  ["hoover-1932", "How much was spent on public works in the fiscal year 1932, by the table?", "655,880,000", ["$655,880,000"]],
  ["hoover-1932", "Which banks were established, along with Agricultural Credit Associations?", "the Home Loan Banks", ["Home Loan Banks"]],
  ["moby-dick-ch1", "What does the narrator ask to be called?", "Ishmael"],
  ["moby-dick-ch1", "Which month does the narrator say it is in his soul when he must go to sea?", "November"],
  ["moby-dick-ch1", "Who throws himself upon his sword with a philosophical flourish?", "Cato"],
  ["moby-dick-ch1", "What does the narrator call his substitute for pistol and ball?", "to get to sea", ["get to sea", "going to sea"]],
  ["moby-dick-ch1", "How does the narrator name the insular city belted round by wharves?", "the Manhattoes", ["Manhattoes", "Manhattan"]],
  ["moby-dick-ch1", "What is at the extreme downtown of the city?", "the battery", ["battery"]],
  ["moby-dick-ch1", "From where to where does the narrator suggest going on a dreamy Sabbath afternoon?", "from Corlears Hook to Coenties Slip", ["Corlears Hook to Coenties Slip"]],
  ["moby-dick-ch1", "In what capacity does the narrator go to sea?", "a simple sailor", ["as a simple sailor", "sailor"]],
  ["moby-dick-ch1", "Whose story does the narrator say holds a still deeper meaning?", "Narcissus"],
  ["moby-dick-ch1", "What does the narrator say you must have a purse to go to sea as?", "a passenger", ["passenger", "as a passenger"]],
];

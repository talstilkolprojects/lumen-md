---
title: Citations (BibTeX)
description: A ```bibtex block becomes a reference list in APA 7, Chicago author-date or MLA 9 — in English or Hebrew, with nothing sent anywhere.
---

Paste BibTeX into a ` ```bibtex ` (or ` ```bib `) block and Lumen shows a
reference list. Pick the style in the block's header; the list is sorted by
author and year, with a hanging indent. Hover a reference to see its
in-text citation.

````markdown
```bibtex
% style: chicago
% lang: he
@article{watson1953molecular,
  author = {Watson, James D. and Crick, Francis H. C.},
  title = {Molecular Structure of Nucleic Acids: A Structure for Deoxyribose Nucleic Acid},
  journal = {Nature}, volume = {171}, number = {4356}, pages = {737--738},
  year = {1953}, doi = {10.1038/171737a0}
}
```
````

## Styles

| Style | Reference | In text |
| --- | --- | --- |
| APA 7 (default) | Watson, J. D., & Crick, F. H. C. (1953). Molecular structure of nucleic acids: A structure for deoxyribose nucleic acid. *Nature*, *171*(4356), 737–738. https://doi.org/10.1038/171737a0 | (Watson & Crick, 1953) |
| Chicago author-date (18th ed.) | Watson, James D., and Francis H. C. Crick. 1953. “Molecular Structure of Nucleic Acids: A Structure for Deoxyribose Nucleic Acid.” *Nature* 171 (4356): 737–38. https://doi.org/10.1038/171737a0. | (Watson and Crick 1953) |
| MLA 9 | Watson, James D., and Francis H. C. Crick. “Molecular Structure of Nucleic Acids: A Structure for Deoxyribose Nucleic Acid.” *Nature*, vol. 171, no. 4356, 1953, pp. 737–38, https://doi.org/10.1038/171737a0. | (Watson and Crick) |

- **APA** turns the title into sentence case. Words in braces keep their
  capitals (`{DNA}`, `{Wonderland}`), as do acronyms and the first word
  after a colon. A German title (`langid = {german}`) keeps its capitals.
- **Chicago** and **MLA** keep the title as written and shorten page ranges
  by their rules (737–38). MLA drops *Company* / *Co.* from publishers and
  writes *University Press* as *UP*.

## Hebrew

`% lang: he` (or Hebrew as the interface language) changes the words, not
the order: *and* / *&* → ו (ו- before a Latin name), *et al.* → ואחרים,
MLA's *vol.* / *no.* / *pp.* → כרך / גיליון / עמ׳. Names, titles and
publishers stay as published. Each reference keeps its own direction.

## Offline

Formatting is Lumen's own rules (no citeproc, no CSL files, no download).
Whether citeproc can be used is an open licensing decision (plan 15.10);
the rules here are the fallback the plan names. Looking up a DOI is not
part of the block — it stays offline.

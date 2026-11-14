---
title: Government data (data.gov.il, CBS)
description: Put a table or a chart of open government data in a note. The rows are kept as a CSV in your vault, the attribution is written for you, and a refresh shows what changed.
---

Lumen can bring two kinds of open Israeli data into a note:

- **data.gov.il** datasets (the government's open data site), and
- **CBS time series** (הלשכה המרכזית לסטטיסטיקה), such as the Consumer
  Price Index (series 120010).

## Turn it on

Government data starts **off**. The first time you use it, Lumen asks to
turn it on. After that, it still asks before every fetch.

## Insert a dataset

1. Choose **Insert government data (data.gov.il)…** in the command palette.
2. Type a few words, such as `תאונות דרכים`. Only these words are sent.
3. Pick the dataset and, when it has several, the table.

Lumen saves the rows as a CSV file in `Data/datagov/<id>/<date>.csv` and
inserts a `dataset` block that shows them as a table or a chart. Opening the
note later reads that file: no request is made, online or offline.

For a CBS series, choose **Insert a CBS series…** and type its number.

## The attribution

Under the block, Lumen writes the attribution line:

- For CBS data, the wording the CBS licence (version 2.1) asks for: the
  product's name, the date you retrieved it, a link to the data, "as is",
  and a link to the licence.
- For data.gov.il, the site, the dataset and its publisher, the date it was
  last updated, the date you retrieved it, and a link.

It is an ordinary line of the note, so it appears in PDF and DOCX exports
too. Keep it when you move the block.

## Refresh

Put the cursor in the block and choose **Refresh this dataset**. Lumen
fetches it again into a new file (the old one stays) and shows the rows
that were added, removed or changed before the note switches to the new
snapshot.

## Personal data

When a dataset has columns that look personal, such as names, ID numbers,
phone numbers or addresses, Lumen warns you before inserting it. The CBS
licence forbids cross-matching its data with other sources to identify
people.

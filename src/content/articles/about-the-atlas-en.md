## Project overview

This project brings together architectural and cultural heritage data from the Wikipedia ecosystem (Wikipedia, Wikidata, and Wikimedia Commons). It currently includes about 330,000 buildings across 36 countries.

A large dataset and good filtering tools are important, but this project's deeper purpose lies in its Wiki popularity ranking. We can certainly say that “every building is beautiful,” but any one person's attention is limited. We inevitably have to distinguish among these places and arrange them by some measure of “importance”; otherwise, we would be overwhelmed by the immense record accumulated over thousands of years of human civilisation. I use the number of Wikipedia language editions for a building as a proxy for its “importance.” In practice, this usually proves to be a useful measure.

Naturally, the project only includes buildings with at least one Wikipedia page, which represent a small fraction of each country's architectural heritage. For example, the French Ministry of Culture's Mérimée database contains 336,240 buildings, while this site includes just 32,134 of them—less than one tenth. My thinking is that Wikipedia editors have already selected the buildings they consider worthy of an article, so we may as well make use of the result of that collective editorial choice.

By combining Wiki popularity with the filters, we can ask questions such as:

- Which relatively well-known (Wiki popularity ≥10) Baroque churches were built in the 17th century (1600–1699)?
- Which relatively well-known castles and châteaux date from the Middle Ages?

## Current limitations

This project relies extensively on data from the Wikipedia ecosystem, so it also inherits its limitations:

- The amount of data varies greatly between countries. Coverage is relatively strong for developed Western countries such as the United States, United Kingdom, France, and Germany; it is thinner for China and Japan, and scarcer still across the Middle East, South America, and Africa.
- Nearly all structured data used to filter places comes from Wikidata. Wikidata is much less widely known than Wikipedia and has fewer editors. Although bots have imported a great deal of data, errors and omissions remain common. For example, only about one third of the buildings have a recorded construction date.
- Total Wikipedia page views might be a better popularity measure, but the page-view API is rate-limited, and the project has not yet collected enough data.
- Chinese-language Wiki resources are relatively limited, so names and tags are usually displayed only in English or the local language.

Even so, Wiki remains the world's largest and best-structured knowledge base. I am not optimistic about attempts to build a separate replacement; they would only divide people's limited effort. If you find errors or missing data, my recommendation is to join Wiki and contribute.

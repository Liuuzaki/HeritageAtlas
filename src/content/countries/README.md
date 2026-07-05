# Country popup content

Add two Markdown files per country, one for each interface language. The
filename is matched to the English country name, case-insensitively; hyphens
can stand in for spaces.

For example, `united-kingdom.en.md` and `united-kingdom.zh.md` customize the
English and Chinese United Kingdom cards. A file can contain ordinary Markdown
such as:

```md
A short description written by hand.

- Coverage note
- Another useful fact

[Data source](https://example.org/)
```

An empty file (or one containing only an HTML comment) leaves the popup as a
header-only card. To add a no-data country marker as well, add its name and
coordinates to `src/countryClusters.ts`.

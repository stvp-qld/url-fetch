# url-fetch

Command line tool to fetch URLs from a predefined source text file (one URL per line), and save responses to a file.

### Command line
npm run start

### With paging: Fetch URL's 101 - 200 from the source file.
npm run start -- --pagestart=2 --pagesize=100

Requests are rate limited to 1 request every 300ms

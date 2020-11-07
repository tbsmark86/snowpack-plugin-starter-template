# snowpack-plugin-typescript-eslint-karma

This is a different take on running the Typescript type-checker. The aim is more
smooth output in a 'stream' style log in watch mode.
Once Typescript is error free eslint is called to get even more checks.
At last output ist written to a tmp-directory where karma can pickup changed
files.

Intendend Advantage:
* less overhead because less extra process watching for file change
* no intermixed output between typescript and eslint
* no useless eslint call if code is invalid
* in-browser testing via karma
  (instead of headless testing done by @web/test-runner)

This of course is all heavly biased by personal taste.

## Development

- `npm run build`: Build the template
- `npm run deploy`: Publish the template to npm using np

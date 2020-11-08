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

## Dependencies

Typescript & Eslint & Karma are all peerDepedencies

## Plugin-Options

* debug?: boolean;
  Print extra debug info
* tsconfig?: string;
  Alternate name for 'tsconfig.json'
* karmaOutput?: string;
  Where to write temporary files for karma unset to disable
  (relative to current dir)
  Karma should be configured to watch this folder to make any sense.
  Also note that karma needs a proxy to the web_modules folder on
  snowpack host.
  If unset karma Server won't be started
* karmaFilter?: (filename: string, content: string) => string;
  Transform File before writing to karmaOutput
  Depending on testing framework you might want to remove the
  import because it must be accesed globaly. Note that clearing a line
  without removing the line break keeps the sourcemap intact.
* karmaConf?: string;
  Alternate name for 'karma.config.js'
* eslintFiles?: string|string[];
  Pattern which files to eslint; Defaults to './'

## Development

- `npm run build`: Build the template
- `npm run deploy`: Publish the template to npm using np

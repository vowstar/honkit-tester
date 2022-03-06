# Honkit integration tests framework

[![Build Status](https://travis-ci.org/vowstar/honkit-tester.svg?branch=master)](https://travis-ci.org/vowstar/honkit-tester)
[![Coverage Status](https://coveralls.io/repos/github/vowstar/honkit-tester/badge.svg?branch=master)](https://coveralls.io/github/vowstar/honkit-tester?branch=master)
[![NPM Version](https://badge.fury.io/js/honkit-tester.svg)](https://badge.fury.io/js/honkit-tester)
[![NPM Downloads](https://img.shields.io/npm/dm/honkit-tester.svg?style=flat)](https://www.npmjs.org/package/honkit-tester)

This is a fork of [gitbook-tester(https://github.com/todvora/gitbook-tester)](https://github.com/todvora/gitbook-tester), port to honkit.

No more mocking of ```npx honkit build```! Verify your honkit-plugin against a real, up-to-date
version of honkit. This integration framework creates a temporary book, attaches your local honkit plugin, runs ```npx honkit build``` and returns the parsed pages content.

All the book resources are generated and executed in a temporary directory (exact location
  depends on your operating system). Resources are cleaned up upon test phase.

## Usage

```js
var tester = require('honkit-tester');
tester.builder()
  .withContent('This text is {% em %}highlighted!{% endem %}')
  .withBookJson({"plugins": ["emphasize"]})
  .create()
  .then(function(result) {
    // do something with results!
    console.log(result[0].content);
  });
```

Expected output is then:

```html
<p>This text is <span class="pg-emphasize pg-emphasize-yellow" style>highlighted !</span></p>
```

Only the ```<section>``` content of generated pages is currently returned. Do you need
to test navigation, the header of page, etc.? Let me know or send me a pull request.

honkit-tester package provides a single entry point:

```js
tester.builder()
```

On the builder, the following methods can be called:

### .withContent(markdownString)

Put some **Markdown** content into the generated book's README.md (initial/intro page).

### .withPage(pageName, pageContent[, level])

Add another book page. For example:

```js
  .withPage('second', 'Second page content')
```

There is no need for specifying extensions, ```.md``` will be automatically added.
The rendered page can be accessed later in tests. For example:

```js
var cheerio = require('cheerio');

it('should add second book page', function(testDone) {
    tester.builder()
    .withContent('First page content')
    .withPage('second', 'Second page content')
    .create()
    .then(function(result) {
      expect(result.get('second.html').content).toEqual(cheerio.load('<p>Second page content</p>')('body').html().trim());
    })
    .fin(testDone)
    .done();
});
```

**Level**: how nested should be this page, optional parameter. ```0``` for top level page, ```1``` for second, ```2``` for third...

### .withBookJson(jsObject)

Put your own ```book.json``` content as a JS object. May contain plugins,
the plugin configuration or anything valid as described in the [official documentation](http://help.gitbook.com/format/configuration.html).
Can also be omitted.

### .withLocalPlugin(path)

Attach currently tested or developed plugin to the generated gitbook files. All locally attached plugins will be automatically added
 to ```book.json``` in the ```plugins``` section.

Should be called
using the following format:

```js
.withLocalPlugin('/some/path/to/module')
```

If you run your tests from the dir ```spec``` of your plugin, you should provide the
path to the root of your plugin module. For example:

```js
.withLocalPlugin(require('path').join(__dirname, '..'))
```

### .withLocalDir(path)

Arrach a user assert dir to the generated gitbook files. This assert dir will
symbolic linked to book dir, and must in the project directory.

Should be called
using the following format:

```js
.withLocalDir(path.join(__dirname, '..', 'assert_dir'))
```

### .withFile(path, content)

Allows you to create a file inside the book directory. Just provide the path for the file and string content. For example:

```js
.withFile('includes/test.md', 'included from an external file!')
```

Then you can use the file however you would like in your plugin or simply include its content in a page. For example:

```markdown
'This text is {% include "./includes/test.md" %}'
```

### .create()

Start a build of the book. Generates all the book resources, installs required
plugins, attaches the provided local modules. Returns ```promise```.

## Working with results

```js
.then(function(result) {
  var index = result.get('index.html');
  console.log(index);  
})
```

should output JavaScript object like

```js
{ path: 'index.html',
  '$': [cheerio representation of the page]
  content: '<h1 id="test-me">test me</h1>' }

```

## Debugging

If you wish to see detailed output of the build and the gitbook logs, provide the ENV variable ``DEBUG=true``.

## Complete test example

How to write a simple test, using node-jasmine.

```js

var tester = require('honkit-tester');
var cheerio = require('cheerio');

// set timeout of jasmine async test. Default is 5000ms. That can
// be too low for a complete test (install, build, expects)
jasmine.getEnv().defaultTimeoutInterval = 20000;

describe("my first honkit integration test", function() {
  it('should create book and parse content', function(testDone) {
    tester.builder()
    .withContent('#test me \n\n![preview](preview.jpg)')
    .create()
    .then(function(result) {
      expect(result[0].content).toEqual(cheerio.load('<h1 id="test-me">test me</h1>\n<p><img src="preview.jpg" alt="preview"></p>')('body').html().trim());
    })
    .fin(testDone)
    .done();
  });
});
```

## License

This project is available under [Apache-2.0](http://choosealicense.com/licenses/apache-2.0/) license.

var tester = require('../lib/tester');
var path = require('path');
var cheerio = require('cheerio');
var assert = require('assert');

describe(__filename, function() {

  it('should create book and parse content', function() {
    return tester.builder()
      .withContent('#test me \n\n![preview](preview.jpg)')
      .create()
      .then(function(result) {
        assert.equal(result.get('index.html').content, cheerio.load('<h1 id="test-me">test me</h1>\n<p><img src="preview.jpg" alt="preview"></p>')('body').html().trim());
      });
  });

  it('should create book with plugins and parse content', function() {
    return tester.builder()
      .withContent('This text is {% em %}highlighted !{% endem %}')
      .withBookJson({"plugins": ["emphasize"]})
      .create()
      .then(function(result) {
        assert.equal(result.get('index.html').content, cheerio.load('<p>This text is <span class="pg-emphasize pg-emphasize-yellow" style="">highlighted !</span></p>')('body').html().trim());
      });
  });

  it('should add external resources and read them during build', function() {
    return tester.builder()
      .withContent('This text is {% include "./includes/test.md" %}')
      .withFile('includes/test.md', 'included from an external file!')
      .create()
      .then(function(result) {
        assert.equal(result.get('index.html').content, cheerio.load('<p>This text is included from an external file!</p>')('body').html().trim());
      });
  });

  it('should add external second book page', function() {
    return tester.builder()
      .withContent('First page content')
      .withPage('second', 'Second page content')
      .create()
      .then(function(result) {
        assert.equal(result.get('index.html').content, cheerio.load('<p>First page content</p>')('body').html().trim());
        assert.equal(result.get('second.html').content, cheerio.load('<p>Second page content</p>')('body').html().trim());
      });
  });

  it('should create pages in a subdirectory', function() {
    return tester.builder()
      .withPage('subdirectory/nested', 'This page is in the directory `subdirectory`.', 1)
      .withPage('subdirectory/also_nested', 'This page is also in the directory `subdirectory`.', 1)
      .create()
      .then(function(result) {
        assert.equal(result.get('subdirectory/nested.html').content, cheerio.load('<p>This page is in the directory <code>subdirectory</code>.</p>')('body').html().trim());
        assert.equal(result.get('subdirectory/also_nested.html').content, cheerio.load('<p>This page is also in the directory <code>subdirectory</code>.</p>')('body').html().trim());
      });
  });

  it('should add local directory and read them during build', function() {
    return tester.builder()
      .withContent('This text is {% include "./test/test.md" %}')
      .withLocalDir(path.join(__dirname, '..', 'test'))
      .create()
      .then(function(result) {
        assert.equal(result.get('index.html').content, cheerio.load('<p>This text is included from user local directory!</p>')('body').html().trim());
      });
  });

  it('should add local normal plugin and using it during build', function() {
    return tester.builder()
      .withContent('This text is {% test %} foobar {% endtest %}')
      .withLocalPlugin(path.join(__dirname, '..', 'test', 'plugin_normal'))
      .create()
      .then(function(result) {
        assert.equal(result.get('index.html').content, cheerio.load('<p>This text is from plugin!</p>')('body').html().trim());
      });
  });

  it('should add local scoped plugin and using it during build', function() {
    return tester.builder()
      .withContent('This text is {% test %} foobar {% endtest %}')
      .withLocalPlugin(path.join(__dirname, '..', 'test', 'plugin_scoped'))
      .create()
      .then(function(result) {
        assert.equal(result.get('index.html').content, cheerio.load('<p>This text is from plugin!</p>')('body').html().trim());
      });
  });

  it('should accept empty values', function() {
    return tester.builder()
      .create()
      .then(function(result) {
        assert.equal(result.get('index.html').content, cheerio.load('')('body').html().trim());
      });
  });

});

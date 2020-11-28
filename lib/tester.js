/*jslint node: true */
"use strict";

var fs = require('fs-extra');
var path = require('path');
var Q = require('q');
var cheerio = require('cheerio');
var temp = require('temp');
var _ = require('lodash');
var mkdirp = require('mkdirp');
var npm = require('npm');
var winston = require('winston');
var spawn = require('child_process').spawn;

temp.track();

var logger = winston.createLogger({
  level: 'silly',
  transports: [
    new winston.transports.Console({
      colorize: true,
      level: process.env.DEBUG ? 'silly' : 'warn',
      timestamp: false,
      handleExceptions: true,
      format: winston.format.cli(),
    }),
    new winston.transports.File({
      filename: '.tester.log',
      colorize: false,
      level: 'silly',
      timestamp: true,
      handleExceptions: true,
      format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY/MM/DD HH:mm:ss' }),
        winston.format.printf(function (info) {
          return info.timestamp + ' [' + info.level + '] ' + info.message;
        })
      )
    })
  ]
});


function endsWith(str, suffix) {
  return str.indexOf(suffix, str.length - suffix.length) !== -1;
}

// generate basic book structure (README.md, SUMMARY.md)
var createBook = function(content, children) {
  return Q.nfcall(temp.mkdir, 'honkit-tester')
    .then(function(dirPath) {

      var summaryPages = children.map(function(page){
        var padding = Array(page.level * 4).join(' ');
        return padding + '* ['+page.name+']('+page.name+'.md)';
      });

      var pagesPromises = children.map(function (page) {
        var pagePaths = page.name.split("/");
        var pageFileName = pagePaths.slice(-1) + ".md";
        var pageSubDirectory = pagePaths.slice(0, -1).join("/");
        var nestedPageDirectory = path.join(dirPath, pageSubDirectory);

        return Q.nfcall(fs.mkdir, nestedPageDirectory)
          .then(
            function () {
              return Q.resolve();
            },
            function (err) {
              if (err.code == 'EEXIST') {
                return Q.resolve();
              } else {
                return Q.fail(err);
              }
            })
          .then(
            function () {
              if (!page.content) {
                throw new Error('page content is empty');
              }
              return Q.nfcall(fs.writeFile, path.join(nestedPageDirectory, pageFileName), page.content);
            }
          );
      });

      var summaryContent = '# Summary\n\n* [Introduction](README.md)' +'\n'+ summaryPages.join('\n');

      if (!summaryContent) {
        throw new Error('summary content is empty');
      }
      if (!content) {
        // if html content is null, set empty content, fix fs.writeFile issue
        content = '';
      }
      var summary = Q.nfcall(fs.writeFile, path.join(dirPath, 'SUMMARY.md'), summaryContent);
      var readme = Q.nfcall(fs.writeFile, path.join(dirPath, 'README.md'), content);

      return Q.all([readme, summary].concat(pagesPromises))
        .then(function() {
          return dirPath;
        });
    });
};

// install book.json to temp book directory. Preprocess book.json and remove from plugins all locally provided
var installBookJson = function(bookPath, bookJson, modules, withLocalPlugins) {
  var localModules = modules || [];
  var book = {plugins:[]};

  if(bookJson) {
    book = _.cloneDeep(bookJson);
  }

  var localModuleNames = localModules.map(function(module) {
    return module.name.replace(/gitbook-plugin-(.*?)/, '$1').replace(/honkit-plugin-(.*?)/, '$1');
  });

  if(!withLocalPlugins) {
    // remove all plugins locally installed plugins from book.json (they would be installed from NPM instead of
    // symlinked.
    var listedPlugins = book.plugins || [];
    book.plugins = listedPlugins.filter(function(plugin) {
      return localModuleNames.indexOf(plugin) == -1;
    });
  } else {
    book.plugins = _.union(book.plugins, localModuleNames);
  }
  return Q.nfcall(fs.writeFile, path.join(bookPath, 'book.json'), JSON.stringify(book))
    .then(function(){return bookPath;});
};

var runCommand = function(command, args, options) {
  var deferred = Q.defer();
  options.shell = false;
  options.silent = false;
  options.stdio = ['pipe', 'pipe', 'pipe', 'ipc'];

  var process = spawn(command, args, options);
  process.on('exit', function (code) {
    // Process completed
    logger.debug('Process completed');
    if (code === 0) {
      deferred.resolve(code);
    } else {
      deferred.reject(new Error('run ' + command  + ' finished, but the exit code is: ' + code));
    }
  });
  process.on('error', function (err) {
    // Process creation failed
    logger.error('Process failed');
    deferred.reject(new Error('run ' + command  + ' failed'));
  });
  process.stdout.on('data', function(data) {
    logger.debug(data.toString());
  });
  process.stderr.on('data', function(data) {
    logger.warn(data.toString());
  });

  return deferred.promise;
};

// read attached folders(=local node modules), normalize path, read module name from package.json
var preprocessLocalModules = function(modules) {
  return modules.map(function(directory) {
    var pathToModule = path.normalize(directory);
    var packageJson = require(path.join(pathToModule, 'package.json'));
    var moduleName = packageJson.name;
    return {dir:pathToModule, name:moduleName};
  });
};

// create symlinks to local plugins
var attachLocalPlugins = function(bookPath, localModules) {
    var nodeModulesPath = path.join(bookPath, 'node_modules');
    return Q.nfcall(fs.mkdir, nodeModulesPath) // create node_modules directory
      .then(function() {
        var promises = localModules.map(function(module) {
          logger.info('creating symlink for plugin ' + module.name + ' to directory ' + module.dir);
          var target = path.join(nodeModulesPath, module.name);
          mkdirp(path.dirname(target)).then(function(){
            return Q.nfcall(fs.symlink, module.dir, target);});
        });
        return Q.all(promises);
      })  // create symlinks to all local modules
      .then(function(){return bookPath;}); // return book path
};

// create symlinks to local dirs
var attachLocalDirs = function(bookPath, localDirs) {
  var promises = localDirs.map(function(dir) {
    var pathToDir = path.normalize(dir);
    var dirName = path.basename(pathToDir);
    var target = path.join(bookPath, dirName);
    logger.info('creating symlink for dir ' + dirName + ' to ' + target);
    return Q.nfcall(fs.symlink, pathToDir, target);
  });
  Q.all(promises).then(function(){return bookPath;}); // return book path
};

var honkitModulePath = function() {
  return path.dirname(require.resolve('honkit/package.json'));
};

var honkitRunnablePath = function(bookPath) {
  // honkit should be installed locally.
  // we can execute honkit directly from installed dependency without globally installed honkit
  var target = path.join(bookPath, 'node_modules', 'honkit', 'bin', 'honkit.js');
  if (fs.existsSync(target)) {
    return target;
  } else {
    logger.error('Honkit installed failed, file not copy to test tmp dir.');
    throw new Error('Honkit installed failed, file not copy to test tmp dir.');
  }
};

var runHonkitCommand  = function(bookPath, args) {
  logger.debug('run command ' + honkitRunnablePath(bookPath) + ' ' + args[0] + ' ' + args[1]);
  return runCommand(honkitRunnablePath(bookPath), args, {'cwd': bookPath}).then(function(){return bookPath;});
};

// run 'npm install' to download all required external plugins
var install = function(bookPath) {
  var deferred = Q.defer();

  var obj = JSON.parse(fs.readFileSync(path.join(bookPath, 'book.json'), 'utf8'));
  if (obj && obj.plugins && obj.plugins.length > 0) {
    npm.load(
      {
        loglevel: 'silent'
      },
      function(err) {
        // install module
        logger.debug("Try install gitbook-plugin-" + obj.plugins + ' into ' + bookPath);
        npm.commands.install(bookPath, ['gitbook-plugin-' + obj.plugins], function(er, data) {
          // log errors or data
          if (er) {
            logger.info('Install ' + 'gitbook-plugin-' + obj.plugins + ' failed');
          } else {
            logger.info('Install ' + 'gitbook-plugin-' + obj.plugins + ' success');
            deferred.resolve(bookPath);
          }
          return bookPath;
        });
        logger.debug("Try install honkit-plugin-" + obj.plugins + ' into ' + bookPath);
        npm.commands.install(bookPath, ['honkit-plugin-' + obj.plugins], function(er, data) {
          // log errors or data
          if (er) {
            logger.info('Install ' + 'honkit-plugin-' + obj.plugins + ' failed');
          } else {
            logger.info('Install ' + 'honkit-plugin-' + obj.plugins + ' success');
            deferred.resolve(bookPath);
          }
          return bookPath;
        });

        npm.on('log', function(message) {
          // log installation progress
          logger.verbose(message);
        });
      }
    );
  }

  return deferred.promise.done(function(){return bookPath;});
};

// run 'npm install honkit' to download honkit to bookParh
var installHonkit = function(bookPath) {
  var deferred = Q.defer();
  try {
    var modulePath = path.join(honkitModulePath(), '..');
    var srcDir = modulePath;
    var destDir = path.join(bookPath, 'node_modules');
    logger.info("Install honkit ...");
    fs.copySync(srcDir, destDir, { overwrite: true, errorOnExist: false }, function (err) {
      if (err) {
        logger.error(err);
        deferred.reject(new Error('Install honkit failed, file not copy to test tmp dir'));
      } else {
        logger.info("Install honkit success!");
        deferred.resolve(bookPath);
      }
    });
  } catch (error) {
    logger.error("Install honkit failed, try using npm install ...");
    npm.load(
      {
        loglevel: 'silent'
      },
      function(err) {
        // install module
        logger.debug('Try install honkit into ' + bookPath);
        npm.commands.install(bookPath, ['honkit'], function(er, data) {
          // log errors or data
          if (er) {
            logger.error('Install honkit failed');
            deferred.reject(new Error('Install honkit failed, file not installed to test tmp dir'));
          } else {
            logger.info('Install honkit success');
            deferred.resolve(bookPath);
          }
        });
      }
    );
  } finally {
    logger.info("Install honkit finished");
  }
  return deferred.promise.done(function(){return bookPath;});
};

// execute 'gitbook build /temp/path/to/generated/book'
var includeFiles = function(bookPath, files) {
  var promises = files.map(function(file){
    var fullFilePath = path.join(bookPath, file.path);
    var dirname = path.dirname(fullFilePath);
    mkdirp(dirname).then(function(){
      return Q.nfcall(fs.writeFile, fullFilePath, file.content);});
  });
  return Q.all(promises)
    .then(function(){return bookPath;});
};

// execute 'gitbook build /temp/path/to/generated/book'
var build = function(bookPath) {
  var command = ['build', bookPath];
  logger.info('build book ...');
  return runHonkitCommand(bookPath, command).then(function(){return bookPath;});
};

// traverse rendered book and return all html files found
var _readFiles = function(bookPath, extension) {
  var deferred = Q.defer();

  var target = path.join(bookPath, '_book');
  if (!fs.existsSync(target)) {
    logger.error('not exist: ' + target);
    deferred.reject(new Error('not exist: ' + target));
  }

  var walk = function(dir, done) {
    var results = [];
    fs.readdir(dir, function(err, list) {
      if (err) return done(err);
      var pending = list.length;
      if (!pending) return done(null, results);
      list.forEach(function(file) {
        file = path.resolve(dir, file);
        fs.stat(file, function(err, stat) {
          if (stat && stat.isDirectory()) {
            walk(file, function(err, res) {
              results = results.concat(res);
              if (!--pending) done(null, results);
            });
          } else {
            results.push(file);
            if (!--pending) done(null, results);
          }
        });
      });
    });
  };

  walk(target, function(err, pages) {
    if (err) {
      logger.error(err);
      deferred.reject(new Error('find files in target fail: ' + target));
    } else {
      deferred.resolve(pages);
    }
  });

  return deferred.promise;
};

// traverse rendered book and return all html files found
var readFiles = function(bookPath) {
  logger.verbose('Read file ...');
  var extensions = ['.html', '.css', '.js'];

  var promises = extensions.map(function(extension){
    return _readFiles(bookPath, extension);
  });

  return Q.all(promises);
};

// convert read html content, parse only <section> content (ignore header, navigation etc)
// TODO: make it configurable, if someone want to test other parts of generated pages
var processFiles = function(bookPath, files) {
  logger.verbose('Process file ...');
  var promises = _.flatten(files).map(function(filename){
    return Q.nfcall(fs.readFile, filename, 'utf-8')
      .then(function(fileContent) {
        var result = {
          path : path.relative(path.join(bookPath, '_book'), filename)
        };
        if(endsWith(filename, '.html')) {
          var $ = cheerio.load(fileContent);
          result.$ = $;
          result.content = $('section').html().trim();
        } else {
          result.content = fileContent;
        }
        return Q.resolve(result);
    });
  });
  return Q.all(promises).then(function(results){
    // preserve backwards compatibility with array-like indexing of results
    var resultsObj = results.reduce(function(acc, val, idx){
      acc[idx] = val;
      return acc;
    }, {});

    resultsObj.get = function(filename) {
      var found = results.filter(function(item){
        return item.path == path.normalize(filename);
      });
      if(found.length > 0) {
        return found[0];
      }
      return null;
    };
    return resultsObj;
  });
};

// main entry point - generate book, install plugins, attach local modules, read and transform html pages
var execute = function(htmlContent, bookJson, localModules, localDirs, files, pages) {
  logger.level = process.env.DEBUG ? 'debug' : 'warn';

  var that = this;

  var modules = preprocessLocalModules(localModules);

  return createBook(htmlContent, pages)
    .then(function(bookPath) {
      // Honkit only search local folder, so should also link to local.
      return attachLocalPlugins(bookPath, modules)
        .then(attachLocalDirs.bind(that, bookPath, localDirs))
        .then(installBookJson.bind(that, bookPath, bookJson, modules, false))
        .then(installHonkit.bind(that, bookPath))
        .then(install.bind(that, bookPath))
        .then(installBookJson.bind(that, bookPath, bookJson, modules, true))
        .then(includeFiles.bind(that, bookPath, files))
        .then(build.bind(that, bookPath))
        .then(readFiles.bind(that, bookPath))
        .then(processFiles.bind(that, bookPath));
    });
};

function Builder() {
  this._content = '';
  this._modules = [];
  this._dirs = [];
  this._files = [];
  this._pages = [];
}

// attach Markdown content to book (currently only to README.md - single page book)
Builder.prototype.withContent = function(content) {
    this._content = content;
    return this;
};

// attach Markdown content to book
Builder.prototype.withPage = function(name, content, level) {
    if(isNaN(level)) {
      level = 0;
    }
    this._pages.push({name:name, content:content, level:level});
    return this;
};

// attach book.json. Expects JS object
Builder.prototype.withBookJson = function(bookJson) {
  this._bookJson = bookJson;
  return this;
};

// attach provided directory / node module as a gitbook plugin. Requires valid npm module structure and package.json
Builder.prototype.withLocalPlugin = function(dir) {
  if (fs.existsSync(dir)) {
    this._modules.push(dir);
  } else {
    throw new Error('Directory can not find:' + dir + ', consider using path.join(__dirname, \'..\', \'your_directory\'');
  }

  return this;
};

// attach provided directory inside the book directory
Builder.prototype.withLocalDir = function(dir) {
  this._dirs.push(dir);
  return this;
};

// create a file inside the book directory
Builder.prototype.withFile = function(path, content) {
  this._files.push({path:path, content:content});
  return this;
};

// start build, return promise with processed html content of pages
Builder.prototype.create = function() {
  return execute(this._content, this._bookJson, this._modules, this._dirs, this._files, this._pages);
};

module.exports = {
  builder: function() {return new Builder();}
};

/*jshint esversion: 9 */
/*jslint node: true */
"use strict";

const fs = require('fs-extra');
const path = require('path');
const cheerio = require('cheerio');
const temp = require('temp');
const _ = require('lodash');
const mkdirp = require('mkdirp');
const winston = require('winston');
const { spawn, exec } = require('child_process');

temp.track();

const logger = winston.createLogger({
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
        winston.format.printf(info => `${info.timestamp} [${info.level}] ${info.message}`)
      )
    })
  ]
});

function endsWith(str, suffix) {
  return str.indexOf(suffix, str.length - suffix.length) !== -1;
}

const createBook = (content, children) => {
  return temp.mkdir('honkit-tester').then(dirPath => {
    const summaryPages = children.map(page => {
      const padding = ' '.repeat(page.level * 4);
      return `${padding}* [${page.name}](${page.name}.md)`;
    });

    const pagesPromises = children.map(page => {
      const pagePaths = page.name.split("/");
      const pageFileName = `${pagePaths.slice(-1)}.md`;
      const pageSubDirectory = pagePaths.slice(0, -1).join("/");
      const nestedPageDirectory = path.join(dirPath, pageSubDirectory);

      return fs.mkdir(nestedPageDirectory)
        .catch(err => {
          if (err.code === 'EEXIST') return;
          throw err;
        })
        .then(() => {
          if (!page.content) throw new Error('page content is empty');
          return fs.writeFile(path.join(nestedPageDirectory, pageFileName), page.content);
        });
    });

    const summaryContent = `# Summary\n\n* [Introduction](README.md)\n${summaryPages.join('\n')}`;
    if (!summaryContent) throw new Error('summary content is empty');
    if (!content) content = ''; // Set empty content if content is null

    const summary = fs.writeFile(path.join(dirPath, 'SUMMARY.md'), summaryContent);
    const readme = fs.writeFile(path.join(dirPath, 'README.md'), content);

    return Promise.all([readme, summary, ...pagesPromises]).then(() => dirPath);
  });
};

const installBookJson = (bookPath, bookJson, modules, withLocalPlugins) => {
  let book = bookJson ? _.cloneDeep(bookJson) : { plugins: [] };
  const localModuleNames = (modules || []).map(module => module.name.replace(/(?:gitbook|honkit)-plugin-(.*?)/, '$1'));

  if (!withLocalPlugins) {
    book.plugins = (book.plugins || []).filter(plugin => !localModuleNames.includes(plugin));
  } else {
    book.plugins = _.union(book.plugins, localModuleNames);
  }

  return fs.writeFile(path.join(bookPath, 'book.json'), JSON.stringify(book)).then(() => bookPath);
};

const runCommand = (command, args, options) => {
  return new Promise((resolve, reject) => {
    const process = spawn(command, args, { ...options, shell: false, silent: false, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });

    process.on('exit', code => {
      logger.debug('Run command finished');
      if (code === 0) {
        resolve(code);
      } else {
        reject(new Error(`run ${command} finished, but the exit code is: ${code}`));
      }
    });

    process.on('error', err => {
      logger.error('Run command failed');
      reject(new Error(`run ${command} failed`));
    });

    process.stdout.on('data', data => logger.debug(data.toString()));
    process.stderr.on('data', data => logger.warn(data.toString()));
  });
};

const preprocessLocalModules = modules => {
  return modules.map(directory => {
    const pathToModule = path.normalize(directory);
    const packageJson = require(path.join(pathToModule, 'package.json'));
    return { dir: pathToModule, name: packageJson.name };
  });
};

const attachLocalPlugins = (bookPath, localModules) => {
  const nodeModulesPath = path.join(bookPath, 'node_modules');
  return fs.mkdir(nodeModulesPath).then(() => {
    const promises = localModules.map(module => {
      logger.info(`Creating symlink for plugin ${module.name} to directory ${module.dir}`);
      const target = path.join(nodeModulesPath, module.name);
      mkdirp.sync(path.dirname(target));
      return fs.symlink(module.dir, target);
    });
    return Promise.all(promises);
  }).then(() => bookPath);
};

const attachLocalDirs = (bookPath, localDirs) => {
  const promises = localDirs.map(dir => {
    const pathToDir = path.normalize(dir);
    const target = path.join(bookPath, path.basename(pathToDir));
    logger.info(`Creating symlink for dir ${path.basename(pathToDir)} to ${target}`);
    return fs.symlink(pathToDir, target);
  });
  return Promise.all(promises).then(() => bookPath);
};

const honkitModulePath = () => path.dirname(require.resolve('honkit/package.json'));

const honkitRunnablePath = bookPath => {
  const target = path.join(bookPath, 'node_modules', 'honkit', 'bin', 'honkit.js');
  return target;
};

const runHonkitCommand = (bookPath, args) => {
  const target = path.join(bookPath, 'node_modules', 'honkit', 'bin', 'honkit.js');

  if (!fs.existsSync(target)) {
    logger.error('Honkit installation failed when trying to run honkit command');
    throw new Error('Honkit installation failed when trying to run honkit command');
  }
  logger.debug(`Run command ${honkitRunnablePath(bookPath)} ${args.join(' ')}`);
  return runCommand(honkitRunnablePath(bookPath), args, { cwd: bookPath }).then(() => bookPath);
};

const install = bookPath => {
  const obj = JSON.parse(fs.readFileSync(path.join(bookPath, 'book.json'), 'utf8'));
  if (obj && obj.plugins && obj.plugins.length > 0) {
    return new Promise(resolve => {
      exec(`npm install gitbook-plugin-${obj.plugins} --prefix ${bookPath}`, () => resolve(bookPath));
      exec(`npm install honkit-plugin-${obj.plugins} --prefix ${bookPath}`, () => resolve(bookPath));
    });
  }
  return Promise.resolve(bookPath);
};

const waitForFile = (filePath, checkInterval = 100, maxRetries = 50) => {
  return new Promise((resolve, reject) => {
    let retries = 0;

    const checkFile = () => {
      if (fs.existsSync(filePath)) {
        resolve(filePath);
      } else if (retries < maxRetries) {
        retries++;
        setTimeout(checkFile, checkInterval);
      } else {
        logger.error(`File not found: ${filePath}`);
        reject(new Error(`File not found: ${filePath}`));
      }
    };

    checkFile();
  });
};

const installHonkit = bookPath => {
  const target = path.join(bookPath, 'node_modules', 'honkit', 'bin', 'honkit.js');
  const srcDir = path.join(honkitModulePath(), '..');
  const destDir = path.join(bookPath, 'node_modules');

  return new Promise((resolve, reject) => {
    try {
      // Check if honkit is already installed
      if (fs.existsSync(target)) {
        logger.info("Honkit already installed");
        resolve(bookPath);
        return;
      }
      // Attempt to install honkit by copying
      logger.info("Installing honkit by copying ...");
      fs.copy(srcDir, destDir, { overwrite: true, errorOnExist: false }, async err => {
        if (err) {
          logger.error('Honkit installation failed by copying. Attempting npm install ...');
          exec(`npm install honkit --prefix ${bookPath}`, async execErr => {
            if (execErr) {
              logger.error('Honkit installation failed by npm');
              reject(new Error('Honkit installation failed by npm'));
            } else {
              logger.info('Honkit installation success by npm');
              try {
                await waitForFile(target);
                resolve(bookPath);
              } catch (fileErr) {
                reject(fileErr);
              }
            }
          });
        } else {
          logger.info("Honkit installation success by copying");
          try {
            await waitForFile(target);
            resolve(bookPath);
          } catch (fileErr) {
            reject(fileErr);
          }
        }
      });
    } catch (error) {
      // Attempt to install honkit by npm
      logger.error("Honkit installation failed, attempting with npm ...");
      exec(`npm install honkit --prefix ${bookPath}`, async execErr => {
        if (execErr) {
          logger.error('Honkit installation failed by npm');
          reject(new Error('Honkit installation failed by npm'));
        } else {
          logger.info('Honkit installation success by npm');
          try {
            await waitForFile(target);
            resolve(bookPath);
          } catch (fileErr) {
            reject(fileErr);
          }
        }
      });
    }
  });
};

const includeFiles = (bookPath, files) => {
  const promises = files.map(file => {
    const fullFilePath = path.join(bookPath, file.path);
    mkdirp.sync(path.dirname(fullFilePath));
    return fs.writeFile(fullFilePath, file.content);
  });
  return Promise.all(promises).then(() => bookPath);
};

const build = bookPath => {
  logger.info('Building book ...');
  return runHonkitCommand(bookPath, ['build', bookPath]).then(() => bookPath);
};

const _readFiles = (bookPath, extension) => {
  const target = path.join(bookPath, '_book');
  if (!fs.existsSync(target)) {
    logger.error('not exist: ' + target);
    return Promise.reject(new Error('Target not found: ' + target));
  }

  const walk = dir => {
    return new Promise((resolve, reject) => {
      let results = [];
      fs.readdir(dir, (err, list) => {
        if (err) return reject(err);
        let pending = list.length;
        if (!pending) return resolve(results);
        list.forEach(file => {
          file = path.resolve(dir, file);
          fs.stat(file, (err, stat) => {
            if (stat && stat.isDirectory()) {
              walk(file).then(res => {
                results = results.concat(res);
                if (!--pending) resolve(results);
              }).catch(reject);
            } else {
              results.push(file);
              if (!--pending) resolve(results);
            }
          });
        });
      });
    });
  };

  return walk(target);
};

const readFiles = bookPath => {
  logger.verbose('Reading files ...');
  const extensions = ['.html', '.css', '.js'];
  return Promise.all(extensions.map(extension => _readFiles(bookPath, extension)));
};

const processFiles = (bookPath, files) => {
  logger.verbose('Processing files ...');
  const promises = _.flatten(files).map(filename => {
    return fs.readFile(filename, 'utf-8').then(fileContent => {
      const result = { path: path.relative(path.join(bookPath, '_book'), filename) };
      if (endsWith(filename, '.html')) {
        const $ = cheerio.load(fileContent);
        result.$ = $;
        result.content = $('section').html().trim();
      } else {
        result.content = fileContent;
      }
      return result;
    });
  });
  return Promise.all(promises).then(results => {
    const resultsObj = results.reduce((acc, val, idx) => {
      acc[idx] = val;
      return acc;
    }, {});

    resultsObj.get = filename => {
      const found = results.find(item => item.path === path.normalize(filename));
      return found || null;
    };

    return resultsObj;
  });
};

const execute = (htmlContent, bookJson, localModules, localDirs, files, pages) => {
  logger.level = process.env.DEBUG ? 'debug' : 'warn';
  const modules = preprocessLocalModules(localModules);

  return createBook(htmlContent, pages)
    .then(bookPath =>
      attachLocalPlugins(bookPath, modules)
        .then(() => attachLocalDirs(bookPath, localDirs))
        .then(() => installBookJson(bookPath, bookJson, modules, false))
        .then(() => installHonkit(bookPath)) // Install honkit, first try
        .then(() => install(bookPath))
        .then(() => installBookJson(bookPath, bookJson, modules, true))
        .then(() => includeFiles(bookPath, files))
        .then(() => installHonkit(bookPath)) // Install honkit, second try, DO NOT REMOVE
        .then(() => build(bookPath))
        .then(() => readFiles(bookPath))
        .then(files => processFiles(bookPath, files))
    );
};

function Builder() {
  this._content = '';
  this._modules = [];
  this._dirs = [];
  this._files = [];
  this._pages = [];
}

Builder.prototype.withContent = function(content) {
  this._content = content;
  return this;
};

Builder.prototype.withPage = function(name, content, level = 0) {
  this._pages.push({ name, content, level });
  return this;
};

Builder.prototype.withBookJson = function(bookJson) {
  this._bookJson = bookJson;
  return this;
};

Builder.prototype.withLocalPlugin = function(dir) {
  if (!fs.existsSync(dir)) throw new Error(`Directory not found: ${dir}`);
  this._modules.push(dir);
  return this;
};

Builder.prototype.withLocalDir = function(dir) {
  this._dirs.push(dir);
  return this;
};

Builder.prototype.withFile = function(filePath, content) {
  this._files.push({ path: filePath, content });
  return this;
};

Builder.prototype.create = function() {
  return execute(this._content, this._bookJson, this._modules, this._dirs, this._files, this._pages);
};

module.exports = {
  builder: () => new Builder()
};

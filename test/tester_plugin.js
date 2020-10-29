var Q = require('q');

function processBlock(blk) {
    var deferred = Q.defer();
    deferred.resolve("from plugin!");
    return deferred.promise;
}

module.exports = {
    blocks: {
        test: {
            process: processBlock
        }
    },
    hooks: {
    }
};

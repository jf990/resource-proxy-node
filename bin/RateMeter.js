/**
 * RateMeter class. Interface with persistent thread-safe storage engine to coordinate
 * the rate monitoring data and tracking. We are using sqlite3 with JavaScript to provide
 * a persistent storage engine that will work when multiple Node processes are running
 * and contending for access to the data store.
 *
 * Each row in the database table tracks the resource utilization of each entry in the serverURLs table.
 *
 * Since accessing the database requires asynchronous functions, most of the query functions
 * return a promise that will later resolve with the result.
 *
 */

const sqlite3 = require('sqlite3');
const fs = require('fs');


module.exports = function (serverURLs, allowedReferrers, logFunction) {
    var dbName = "proxy.sqlite";
    var dbFileAccessMode = fs.constants.R_OK | fs.constants.W_OK;
    var dbConnection = null;
    var isNewDatabase = false;
    var serverURLConfig = serverURLs;
    var serverAllowedReferrers = allowedReferrers;
    var errorLoggingFunction = logFunction;

    /**
     * Internal database error logger that formats a nice error message and then calls the provided
     * error logging function to actually log it. This way RateMeter doesn't have to know anything
     * about how the app wants to handle logging.
     * @param fromWhere {string} an indication where in this module the error occurred.
     * @param sql {string|null} the sql query if you want to show it in the log
     * @param params {Array|string|null} the parameters provided to the sql query
     * @param databaseError {Exception|null} the error object, if not null then must support toString()
     */
    function logDatabaseError(fromWhere, sql, params, databaseError) {
        var message;

        if (errorLoggingFunction != null) {
            message = 'Internal database error';
            if (databaseError != null) {
                message += ': ' + databaseError.toString();
            }
            if (fromWhere != null && fromWhere.length > 0) {
                message += ' in ' + fromWhere;
            }
            if (sql != null && sql.length > 0) {
                message += ' ' + sql;
            }
            if (params != null) {
                if (typeof params == Array && params.length > 0) {
                    message += '(' + params.join + ')';
                } else {
                    message += '(' + params.toString() + ')';
                }
            }
            errorLoggingFunction(message);
        }
    }

    /**
     * A time function to return fractions of a second.
     * @returns {number}
     */
    function getMicroTime() {
        return new Date().getTime() / 1000;
    }

    /**
     * Create the entire database and all records we are going to rate monitor. We create all records in advance because
     * we know them now and they won't change and we will save runtime overhead by not creating new rows and indexing.
     */
    function createDatabaseIfNotExists() {
        var sql,
            params,
            serverURL,
            rate,
            timeOfAccess = getMicroTime(),
            serverIndex,
            referrerIndex;

        if (dbConnection != null) {
            dbConnection.serialize(function() {
                dbConnection.run('CREATE TABLE IF NOT EXISTS ips (id INTEGER PRIMARY KEY, url VARCHAR(255) not null, referrer VARCHAR(255) not null, count INTEGER not null default(0), rate INTEGER not null default(0), time INTEGER not null default(0), total INTEGER not null default(0), rejected INTEGER not null default(0))');
                dbConnection.run('CREATE UNIQUE INDEX IF NOT EXISTS url_referrer ON ips (url, referrer)');
                dbConnection.run('DELETE from ips');
                sql = 'INSERT OR IGNORE INTO ips (url, referrer, count, rate, time, total, rejected) VALUES (?, ?, ?, ?, ?, ?, ?)';
                for (serverIndex = 0; serverIndex < serverURLConfig.length; serverIndex ++) {
                    serverURL = serverURLConfig[serverIndex];
                    if (serverURL.useRateMeter) {
                        for (referrerIndex = 0; referrerIndex < serverAllowedReferrers.length; referrerIndex ++) {
                            params = [serverURL.url, serverAllowedReferrers[referrerIndex].referrer, 0, serverURL.rate, timeOfAccess, 0, 0];
                            dbConnection.run(sql, params);
                        }
                    }
                }
            });
        }
    }

    /**
     * Refresh the entire table. This function will rebuild the entire table. When you call this function all current
     * counters and rate meters are removed.
     * @param newServerUrlTable
     * @param newReferrers
     */
    function refreshServerUrls(newServerUrlTable, newReferrers) {
        var serverIndex,
            referrerIndex,
            serverURL,
            timeOfAccess = getMicroTime(),
            sql,
            params;

        serverURLConfig = newServerUrlTable;
        serverAllowedReferrers = newReferrers;
        if (dbConnection != null) {
            dbConnection.serialize(function() {
                dbConnection.run('TRUNCATE TABLE ips');
                sql = 'INSERT OR IGNORE INTO ips (url, referrer, count, rate, time, total, rejected) VALUES (?, ?, ?, ?, ?, ?, ?)';
                for (serverIndex = 0; serverIndex < newServerUrlTable.length; serverIndex ++) {
                    serverURL = newServerUrlTable[serverIndex];
                    if (serverURL.useRateMeter) {
                        for (referrerIndex = 0; referrerIndex < newReferrers.length; referrerIndex ++) {
                            params = [serverURL.url, newReferrers[referrerIndex], 0, serverURL.rate, timeOfAccess, 0, 0];
                            dbConnection.run(sql, params);
                        }
                    }
                }
            });
        }
    }

    /**
     * Return the database connection. A new connection is created if one did not already exist.
     * @returns {*}
     */
    function openDatabase() {
        if (dbConnection == null) {
            isNewDatabase = false; // ! fs.accessSync(dbName, dbFileAccessMode); // TODO: why does this fail?
            dbConnection = new sqlite3.Database(dbName, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, createDatabaseIfNotExists);
            if (dbConnection != null) {
                if (isNewDatabase) {
                    fs.chmodSync(dbName, '770');
                }
            }
        }
        return dbConnection;
    }

    /**
     * Close the database freeing any connections and resources consumed.
     */
    function closeDatabase() {
        if (dbConnection != null) {
            dbConnection.close();
            dbConnection = null;
        }
    }

    /**
     * Query the database for an aggregate count of all monitored connections for a given URL we are monitoring.
     * @param url {string} If null or '' then return a sum of all totals, otherwise use this as a key to look up the total for.
     * @returns {Promise} The resolve function is passed the total as the first parameter.
     */
    function getTotalCount(url) {
        var sql,
            params,
            promise;

        promise = new Promise(function(resolvePromise, rejectPromise) {
            if (dbConnection == null) {
                openDatabase();
            }
            if (dbConnection != null) {
                if (url != null && url.length > 0) {
                    sql = "SELECT sum(total) as total FROM ips where url=?";
                    params = [url];
                } else {
                    sql = "SELECT sum(total) as total FROM ips";
                    params = [];
                }
                dbConnection.get(sql, params, function (error, queryResult) {
                    if (error != null) {
                        logDatabaseError('getTotalCount', sql, params, error);
                        rejectPromise(error);
                    } else {
                        resolvePromise(queryResult.total);
                    }
                });
            }
        });
        return promise;
    }

    /**
     * Produce a dump of all rows in the table. Returns a Promise that will pass an array of table rows as
     * its first parameter to the resolve function.
     * @returns {Promise} We promise to eventually return an array of all rows in the table.
     */
    function allRowsAsArray() {
        var promise,
            sql,
            params;

        promise = new Promise(function(resolvePromise, rejectPromise) {
            if (dbConnection == null) {
                openDatabase();
            }
            if (dbConnection != null) {
                sql = "SELECT id, url, referrer, total, count, rejected, rate, time FROM ips";
                params = [];
                dbConnection.all(sql, params, function (error, queryResult) {
                    if (error != null) {
                        logDatabaseError('allRowsAsArray', sql, params, error);
                        rejectPromise(error);
                    } else {
                        resolvePromise(queryResult);
                    }
                });
            } else {
                rejectPromise(Error('Not able to open or create the database.'));
            }
        });
        return promise;
    }

    /**
     * Determine if the monitored resource (by its id) is under it's allotted rate monitor cap. When returning true
     * this function also updates the monitored rate.
     * @param referrer {string} the referrer to track.
     * @param serverURL {object} the URL info we are tracking that matches this request.
     * @returns {Promise} returns a Promise where the resolve function is passed a boolean that is false if this resource exceeded its rate.
     */
    function isUnderMeterCap(referrer, serverURL) {
        var timeOfRequest = getMicroTime(),
            newCount,
            refreshTime,
            sql,
            params,
            promise,
            isOK = false;

        promise = new Promise(function(resolvePromise, rejectPromise) {
            if (dbConnection != null) {
                // read db by url to get current data (since other threads may also be updating it.)
                // check if count exceeded
                // if not, update record with new count and timestamp.

                dbConnection.serialize(function () {
                    sql = "SELECT id, url, referrer, total, count, rate, time FROM ips WHERE referrer=? and url=?";
                    params = [referrer, serverURL.url];

                    dbConnection.get(sql, params, function (error, queryResult) {
                        if (error != null) {
                            logDatabaseError('selectLastRequest', sql, params, error);
                            rejectPromise(error);
                        } else {
                            if (queryResult != null) {
                                if (queryResult.count == 0 || (queryResult.time + serverURL.ratePeriodSeconds <= timeOfRequest)) {
                                    // either the first time in, or the prior time window has expired
                                    newCount = 1;
                                    refreshTime = timeOfRequest;
                                    isOK = true;
                                } else if (queryResult.count < serverURL.rate) {
                                    // in the current time window we have not yet given out the maximum number of hits
                                    newCount = queryResult.count + 1;
                                    refreshTime = queryResult.time;
                                    isOK = true;
                                // } else {
                                    // already gave out the limit for the current time window
                                    // isOK = false;
                                }
                                if (isOK) {
                                    sql = "UPDATE ips SET total=total+1, count=?, time=? WHERE id=?";
                                    params = [newCount, refreshTime, queryResult.id];
                                    dbConnection.run(sql, params, function (error) {
                                        if (error != null) {
                                            logDatabaseError('updateRequest', sql, params, error);
                                        }
                                    });
                                } else {
                                    sql = "UPDATE ips SET rejected=rejected+1 WHERE id=?";
                                    params = [queryResult.id];
                                    dbConnection.run(sql, params, function (error) {
                                        if (error != null) {
                                            logDatabaseError('updateRequest', sql, params, error);
                                        }
                                    });
                                }
                                resolvePromise(isOK);
                            } else {
                                error = new Error('no record exists for ' + referrer + ', ' + url);
                                logDatabaseError('selectLastRequest', sql, params, error);
                                resolvePromise(error);
                            }
                        }
                    });
                });
            } else {
                rejectPromise(new Error('Database connection was not open. Call start() first.'));
            }
        });
        return promise;
    }

    /**
     * This is the public API:
     */
    return {
        /**
         * Start should be called before monitoring begins. This opens the database connection and manages
         * on connection resource for the node thread we are running on. If start() is not called then each
         * call to isExceeded will open and close its own database connection.
         */
        start: function() {
            openDatabase();
        },

        /**
         * Call stop when shutting down or monitoring is no longer needed. This closes the database connection
         * and frees any resources consumed by this object.
         */
        stop: function() {
            closeDatabase();
        },

        /**
         * Determine if the resource (given its URL and the referrer who is accessing it) has exceeded its rate
         * monitoring cap. Returns a Promise that will resolve when the query completes. The Promise is passed
         * either true when the current rate is less than the required maximum rate or false after it has been
         * exceeded. start() must be called before this function or it will fail.
         * @param referrer {string} referrer we are monitoring.
         * @param url {string} url of the resource we are monitoring requested by referrer.
         * @returns {Promise} A single boolean value is passed to the resolve function that will be true while
         * under the rate cap, and false when exceeding the rate cap.
         */
        isUnderRate: function (referrer, url) {
            return isUnderMeterCap(referrer, url);
        },

        /**
         * If the serverURLs table changes after the constructor was called you can repopulate it
         * by calling this method with the new table. This will drop all active rate counters and
         * start them again.
         * @param serverUrls
         * @returns {*}
         */
        refreshUrlTable: function(serverUrls) {
            return refreshServerUrls(serverUrls);
        },

        /**
         * Produces an array of objects of all rows in the table. This function returns a Promise that will
         * resolve with the array of database rows, each row is an object.
         * @returns {Promise}
         */
        databaseDump: function() {
            return allRowsAsArray();
        }
    }
};

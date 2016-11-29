/**
 * "Quick" and simple logging function. Logs messages to a log file.
 * Created on 8/24/16.
 */

const fs = require('fs');

var defaultLogFileName = 'arcgis-proxy.txt',
    logFileName = 'arcgis-proxy-node.log',
    logToConsole = true,
    logLevelValue = 9;


// LOGLEVELs control what type of logging will appear in the log file and on the console.
module.exports.LOGLEVEL = {
    ALL:   {label: "ALL",   value: 9, key: "A"},
    INFO:  {label: "INFO",  value: 5, key: "I"},
    WARN:  {label: "WARN",  value: 4, key: "W"},
    ERROR: {label: "ERROR", value: 3, key: "E"},
    NONE:  {label: "NONE",  value: 0, key: "X"}
};

/**
 * Determine if a requested log level is greater or equal to the current log level in effect. This is helpful if
 * you want to do something based on a particular logging level or higher.
 * @param logLevelLabel
 * @returns {boolean}
 */
module.exports.ifLogLevelGreaterOrEqual = function(logLevelLabel) {
    var logInfo = this.getLogLevelInfoFromLabel(logLevelLabel);
    if (logInfo != null) {
        return logInfo.value >= logLevelValue;
    } else {
        return false;
    }
};

/**
 * Check the configuration and verify access to the log file. The configuration object should have the following
 * attributes, any of which are optional and when not found a suitable default is used:
 * {
 *    logLevel: "ALL",
 *    logToConsole: true,
 *    logFilePath: "./",
 *    logFileName: "file-name.txt",
 * }
 * @param configuration {object} see above.
 * @returns {boolean} true if a valid configuration is consumed, false if something is invalid and we cannot function.
 */
module.exports.setConfiguration = function(configuration) {
    var logFilepath,
        logLevelInfo,
        isValid = false;

    logToConsole = configuration.logConsole !== undefined ? configuration.logConsole == true : false;
    logLevelValue = configuration.logLevel !== undefined ? configuration.logLevel : this.LOGLEVEL.NONE.value;
    if (configuration.logFilePath != null || configuration.logFileName != null) {
        if (configuration.logFilePath == null) {
            logFilePath = './';
        } else if (configuration.logFilePath.charAt(configuration.logFilePath.length - 1) != '/') {
            logFilePath = configuration.logFilePath + '/';
        } else {
            logFilePath = configuration.logFilePath;
        }
        if (configuration.logFileName != null) {
            if (configuration.logFileName.charAt(0) == '/') {
                logFileName = logFilePath + configuration.logFileName.substr(1);
            } else {
                logFileName = logFilePath + configuration.logFileName;
            }
        } else {
            logFileName = logFilePath + defaultLogFileName;
        }
    } else {
        logFileName = './' + defaultLogFileName;
    }
    if (logFileName != null) {
        try {
            fs.accessSync(logFilePath, fs.constants.R_OK | fs.constants.W_OK);
            isValid = true;
        } catch (error) {
            this.logEventImmediately(this.LOGLEVEL.ERROR.value, 'No write access to log file ' + logFilePath + ": " + error.toString());
            logFileName = null;
            isValid = false;
        }
    }
    return isValid;
};

/**
 * Helper function to log an INFO level event.
 * @param message
 */
module.exports.logInfoEvent = function(message) {
    this.logEvent(this.LOGLEVEL.INFO.value, message);
};

/**
 * Helper function to log an WARN level event.
 * @param message
 */
module.exports.logWarnEvent = function(message) {
    this.logEvent(this.LOGLEVEL.WARN.value, message);
};

/**
 * Helper function to log an ERROR level event.
 * @param message
 */
module.exports.logErrorEvent = function(message) {
    this.logEvent(this.LOGLEVEL.ERROR.value, message);
};

/**
 * Log a message to a log file only if a log file was defined and we have write access to it. This
 * function appends a new line on the end of each call.
 *
 * @param logLevelForMessage {int} the log level value used to declare the level of logging this event represents. If this value
 *            is less than the configuration log level then this event is not logged.
 * @param message {string} the message to write to the log file.
 */
module.exports.logEvent = function(logLevelForMessage, message) {
    if (logLevelForMessage <= logLevelValue) {
        if (logFileName != null) {
            fs.appendFile(logFileName, this.formatLogMessage(this.formatLogLevelKey(logLevelForMessage) + message), {flag: 'a'}, function (error) {
                if (error != null) {
                    console.log('*** Error writing to log file ' + logFileName + ": " + error.toString());
                    throw error;
                }
            });
        }
        if (logToConsole) {
            console.log(message);
        }
    }
};

/**
 * Adds current date and CRLF to a log message.
 * @param message
 * @returns {string}
 */
module.exports.formatLogMessage = function(message) {
    var today = new Date();
    return today.toISOString() + ": " + message.toString() + '\n';
};

/**
 * Return a formatted key representing the log level that was used to log the event. This way a log processor can
 * see the level that matched the log event.
 * @param logLevel
 * @returns {String} Log level identifier key with formatting.
 */
module.exports.formatLogLevelKey = function(logLevel) {
    var logInfo = this.getLogLevelInfoFromValue(logLevel);
    if (logInfo != null) {
        return '[' + logInfo.key + '] ';
    } else {
        return '';
    }
};

/**
 * Given a log level value return the related log level info.
 * @param logLevelValue the integer value of the log level we are interested in.
 * @returns {*} Object if match, null if undefined log level value.
 */
module.exports.getLogLevelInfoFromValue = function(logLevelValue) {
    var logInfoKey,
        logInfo;

    for (logInfoKey in this.LOGLEVEL) {
        if (this.LOGLEVEL.hasOwnProperty(logInfoKey)) {
            logInfo = this.LOGLEVEL[logInfoKey];
            if (logInfo.value == logLevelValue) {
                return logInfo;
            }
        }
    }
    return null;
};

/**
 * Given a log level label return the related log level info.
 * @param logLevelLabel the string label of the log level we are interested in.
 * @returns {*} Object if match, null if undefined log level value.
 */
module.exports.getLogLevelInfoFromLabel = function(logLevelLabel) {
    var logInfoKey,
        logInfo;

    for (logInfoKey in this.LOGLEVEL) {
        if (this.LOGLEVEL.hasOwnProperty(logInfoKey)) {
            logInfo = this.LOGLEVEL[logInfoKey];
            if (logInfo.label == logLevelLabel) {
                return logInfo;
            }
        }
    }
    return null;
};

/**
 * Synchronous file write for logging when we are in a critical situation, like shut down.
 * @param logLevelForMessage {int} logging level for this message.
 * @param message {string} a message to show in the log.
 */
module.exports.logEventImmediately = function(logLevelForMessage, message) {
    if (logLevelForMessage <= logLevelValue) {
        if (logFileName != null) {
            fs.appendFileSync(logFileName, this.formatLogMessage(message));
        }
        if (logToConsole) {
            console.log(message);
        }
    }
};

/**
 * Return size of the log file.
 */
module.exports.getLogFileSize = function() {
    var fstatus,
        result;

    try {
        if (logFileName != null) {
            fstatus = fs.statSync(logFileName);
            if (fstatus != null) {
                result = Math.round(fstatus.size / 1000) + 'K';
            } else {
                result = 'Log file error.';
            }
        } else {
            result = 'No log file.';
        }
    } catch (exception) {
        result = 'Log file error ' + exception.toLocaleString();
    }
    return result;
};

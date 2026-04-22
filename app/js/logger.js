window.logSession = function logSession() {
  if (window.console && console.log) {
    console.log.apply(console, arguments);
  }
};

// Tests run fake sites on 127.0.0.1, so local addresses are on here; a deployed
// monitor leaves MONITOR_ALLOW_LOCAL unset (the checks package).
process.env.MONITOR_ALLOW_LOCAL = "1";

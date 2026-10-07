# sqltools.sh: the app tier's sidecar (ca-app, "sqltools"), run as bash -c by main.tf.
#
# Plain English: the SQL Server image is used only for its sqlcmd; the
# database engine in it never starts. Once a minute, sqlcmd logs in to appdb
# as labadmin (SQLCMDSERVER, SQLCMDUSER, SQLCMDDBNAME from plain settings,
# SQLCMDPASSWORD from the app's secret sql-password) and writes one line, or
# the error, to /shared/db.txt for the API container to show.
SQLCMD=/opt/mssql-tools18/bin/sqlcmd
[ -x "$SQLCMD" ] || SQLCMD=/opt/mssql-tools/bin/sqlcmd
QUERY="SET NOCOUNT ON; SELECT CONCAT('connected to ', @@SERVERNAME, '/', DB_NAME(), ' (', CONVERT(varchar(20), DATABASEPROPERTYEX(DB_NAME(), 'Edition')), '), ', CONVERT(varchar(19), SYSUTCDATETIME(), 120), ' UTC')"
while true; do
  "$SQLCMD" -S "tcp:$SQLCMDSERVER,1433" -h -1 -W -l 15 -Q "$QUERY" > /shared/db.tmp 2>&1
  mv /shared/db.tmp /shared/db.txt
  sleep 60
done

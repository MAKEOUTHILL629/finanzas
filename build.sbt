name := """finanzas"""
organization := "com.makeouthill"

version := "1.0-SNAPSHOT"

lazy val root = (project in file(".")).enablePlugins(PlayScala)

scalaVersion := "2.13.16"

libraryDependencies += guice
libraryDependencies += jdbc
libraryDependencies += "org.postgresql" % "postgresql" % "42.7.3"
libraryDependencies += "org.scalatestplus.play" %% "scalatestplus-play" % "7.0.1" % Test
libraryDependencies += "com.github.jwt-scala" %% "jwt-play-json" % "10.0.4"
libraryDependencies += "org.mindrot" % "jbcrypt" % "0.4"
libraryDependencies += "org.apache.commons" % "commons-csv" % "1.10.0"
libraryDependencies += "org.jsoup" % "jsoup" % "1.17.2"


// Adds additional packages into Twirl
//TwirlKeys.templateImports += "com.makeouthill.controllers._"

// Adds additional packages into conf/routes
// play.sbt.routes.RoutesKeys.routesImport += "com.makeouthill.binders._"

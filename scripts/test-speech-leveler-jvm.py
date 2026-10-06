"""Run SpeechLevelerTest on the JVM using already-cached Gradle dependencies.

Requires JDK 17+ and Kotlin 2.2.20 / JUnit 4.13.2 in the local Gradle cache.
This does not replace connectedDebugAndroidTest on an Android device.
"""

import os
from pathlib import Path
import subprocess
import tempfile

os.chdir(Path(__file__).resolve().parent.parent)
cache = Path.home() / ".gradle/caches/modules-2/files-2.1"


def jar(group: str, artifact: str, version: str) -> str:
    matches = list((cache / group / artifact / version).glob("*/*.jar"))
    if len(matches) != 1:
        raise RuntimeError(f"Expected cached {group}:{artifact}:{version}")
    return str(matches[0])


compiler = jar("org.jetbrains.kotlin", "kotlin-compiler-embeddable", "2.2.20")
dependencies = [
    jar("org.jetbrains.kotlin", "kotlin-stdlib", "2.2.20"),
    jar("org.jetbrains.kotlin", "kotlin-script-runtime", "2.2.20"),
    jar("org.jetbrains.kotlin", "kotlin-reflect", "1.9.0"),
    jar("org.jetbrains.kotlinx", "kotlinx-coroutines-core-jvm", "1.8.0"),
    jar("org.jetbrains", "annotations", "23.0.0"),
    jar("junit", "junit", "4.13.2"),
    jar("org.hamcrest", "hamcrest-core", "1.3"),
]
classpath = os.pathsep.join(dependencies)
java_home = os.environ.get("JAVA_HOME")
java = str(Path(java_home) / "bin/java") if java_home else "java"
output = tempfile.mkdtemp(prefix="bondfires-kotlin-")
base = Path("apps/mobile/modules/bondfire-live-publisher/android/src")
sources = [
    str(base / "main/java/org/bondfires/livepublisher/SpeechLeveler.kt"),
    str(base / "androidTest/java/org/bondfires/livepublisher/SpeechLevelerTest.kt"),
]
subprocess.run([
    java, "-cp", compiler + os.pathsep + classpath,
    "org.jetbrains.kotlin.cli.jvm.K2JVMCompiler", "-no-stdlib", "-no-reflect",
    "-classpath", classpath, "-d", output, *sources,
], check=True)
subprocess.run([
    java, "-cp", output + os.pathsep + classpath, "org.junit.runner.JUnitCore",
    "org.bondfires.livepublisher.SpeechLevelerTest",
], check=True)

cmake_minimum_required(VERSION 3.26)
project(dial8_local_tts LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Everything below comes from build.sh: pinned, SHA-256-verified dependencies
# in .out/deps, upstream with patches/ applied in .out/src, and the voices
# compiled into a source file in .out/gen. We don't use upstream's own
# CMakeLists.txt, which fetches unpinned dependencies at configure time.
set(PTT_SOURCE_DIR "" CACHE PATH "upstream pocket_tts.cpp with patches/ applied")
set(ORT_ROOT "" CACHE PATH "ONNX Runtime release archive (osx-arm64)")
set(ORT_VERSION "" CACHE STRING "ONNX Runtime version (the dylib's name)")
set(SPM_ROOT "" CACHE PATH "static SentencePiece: include/ and lib/libsentencepiece.a")
set(DR_LIBS_DIR "" CACHE PATH "dr_libs checkout (dr_wav.h, dr_mp3.h, dr_flac.h)")
set(VOICES_SOURCE "" CACHE FILEPATH "generated source that embeds voices/")
set(PTT_UPSTREAM_SHA "unknown" CACHE STRING "Pinned upstream commit, reported in hello")

# The engine: upstream's single source file without its CLI/HTTP main
# (PTT_SHARED_LIB). Our declaration of its C API is force-included, so an
# upstream signature change fails here instead of miscalling at run time.
add_library(pocket_tts STATIC ${PTT_SOURCE_DIR}/pocket_tts.cpp)
target_compile_definitions(pocket_tts PRIVATE PTT_SHARED_LIB)
target_compile_options(pocket_tts PRIVATE -w -include ${CMAKE_CURRENT_SOURCE_DIR}/src/pocket_tts_api.h)
target_include_directories(pocket_tts PRIVATE ${SPM_ROOT}/include ${DR_LIBS_DIR})
target_include_directories(pocket_tts PUBLIC ${ORT_ROOT}/include)
target_link_libraries(pocket_tts PUBLIC
    ${ORT_ROOT}/lib/libonnxruntime.${ORT_VERSION}.dylib
    ${SPM_ROOT}/lib/libsentencepiece.a)

# The sidecar. build.sh writes VOICES_SOURCE after building the tool below.
set_source_files_properties(${VOICES_SOURCE} PROPERTIES GENERATED TRUE)
add_executable(dial8-local-tts src/main.cpp ${VOICES_SOURCE})
target_link_libraries(dial8-local-tts PRIVATE pocket_tts)
target_compile_definitions(dial8-local-tts PRIVATE PTT_UPSTREAM_SHA="${PTT_UPSTREAM_SHA}")
target_compile_options(dial8-local-tts PRIVATE -Wall -Wextra)
# Upstream's HTTP server and CLI helpers are unused here.
target_link_options(dial8-local-tts PRIVATE -Wl,-dead_strip)

# Developer tool for voices/make-voice.sh (.out/tools, never shipped).
add_executable(dial8-tts-make-voice src/make_voice.cpp)
target_link_libraries(dial8-tts-make-voice PRIVATE pocket_tts)
target_compile_options(dial8-tts-make-voice PRIVATE -Wall -Wextra)
target_link_options(dial8-tts-make-voice PRIVATE -Wl,-dead_strip)

# libonnxruntime lives in Dial8.app/Contents/Frameworks (bundle) or .out/lib
# (dev); the tool, in .out/tools, uses the copy in .out/deps.
set_target_properties(dial8-local-tts PROPERTIES
    BUILD_WITH_INSTALL_RPATH ON
    INSTALL_RPATH "@executable_path/../Frameworks;@executable_path/../lib")
set_target_properties(dial8-tts-make-voice PROPERTIES
    BUILD_WITH_INSTALL_RPATH ON
    INSTALL_RPATH "@executable_path/../deps/onnxruntime/lib")

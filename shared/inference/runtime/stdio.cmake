# llama-stdio (stdio.cpp), added to llama.cpp's tools/server/CMakeLists.txt as the image builds it
add_executable(llama-stdio stdio.cpp)
target_include_directories(llama-stdio PRIVATE ${PROJECT_SOURCE_DIR}/src)
target_compile_definitions(llama-stdio PRIVATE RUNTIME_COMMIT="${RUNTIME_COMMIT}")
target_link_libraries(llama-stdio PRIVATE server-context vendor::hash)
target_compile_features(llama-stdio PRIVATE cxx_std_17)

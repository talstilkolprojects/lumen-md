package com.getcapacitor;
import java.lang.annotation.*;
@Retention(RetentionPolicy.RUNTIME) @Target(ElementType.METHOD)
public @interface PluginMethod { String returnType() default "promise"; }
